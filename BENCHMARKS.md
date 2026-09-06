# Benchmarks

Measurements of this API under the official stress test of the
[Rinha de Backend 2023/Q3](https://github.com/zanfranceschi/rinha-de-backend-2023-q3).

Each approach changes **one variable at a time** and is measured under identical
conditions, so the numbers are directly comparable.

The endpoint names — `criação`, `consulta`, `busca válida`, `busca inválida` —
are kept in Portuguese throughout: they are the literal request labels of the
official Gatling simulation, and they appear that way in every report. They mean
creation, fetch, valid search and invalid search.

---

## Comparison

| # | Approach | Success | People created | p50 | p99 | Peak throughput | Breaking point | Bottleneck |
|---|---|---|---|---|---|---|---|---|
| [1](#approach-1--single-connection-1-replica) | `pg.Client`, 1 replica | 59.60% | 25,166 | 1 ms | 1,486 ms | 610 req/s | 371 u/s | `Seq Scan`, no index |
| [2](#approach-2--single-connection-2-replicas) | `pg.Client`, 2 replicas | 74.49% | 32,111 | 1 ms | 1,576 ms | 745 req/s | 459 u/s | `Seq Scan`, no index |
| [3](#approach-3--single-connection-1-replica-gin--pg_trgm-index) | `pg.Client`, 1 replica, GIN `pg_trgm` | **93.62%** | **42,851** | 1 ms | **733 ms** | **1,257 req/s** | 467 u/s | single connection + nginx slots |
| [4](#approach-4--2-replicas-gin--pg_trgm-index) | `pg.Client`, 2 replicas, GIN `pg_trgm` | **99.96%** | **46,549** | 1 ms | **212 ms** | 1,256 req/s ¹ | — | single-connection spikes → nginx slots |
| [5](#approach-5--connection-per-request-tryfinally) | connection per request, 2 replicas, GIN | 99.51% | 45,660 | 5 ms | 203 ms | 1,263 req/s ¹ | — | Postgres `max_connections` |
| [6](#approach-6--connection-pool-pgpool) | `pg.Pool` (10/process), 2 replicas, GIN | **100.00%** | **46,580** | 1 ms | **20 ms** | 1,267 req/s ¹ | — | **none reached** |
| [7](#approach-7--compliance-15-cpu-and-30-gb) | pool + 2 replicas + GIN, **1.5 CPU / 3.0 GB** | 60.72% | 23,611 | 1 ms | 2,429 ms | 902 req/s ² | 395 u/s | Postgres CPU (throttling) |
| [8](#approach-8--compliance-with-a-redistributed-budget) | same, budget redistributed (db 1.00) | 74.54% | 30,603 | 1 ms | 1,590 ms | 1,600 req/s ² | 499 u/s | Postgres CPU (throttling) |


¹ From approach 3 onward, peak throughput becomes limited by the Gatling ramp,
which saturates at 740 users/s. The number stops measuring the capacity of the
system — see the [diagnosis of approach 4](#the-2-question-could-not-be-answered).

---

## Approach 1 — single connection, 1 replica

```
nginx (1 worker, 512 slots)
  └── api1 ── 1 Node process ── 1 connection ── Postgres
```

The naive starting point: a single Node process opens **one** connection to
Postgres at boot and reuses it for every request. No pool, no replicas, no
indexes beyond the ones the schema creates. It serves as the baseline for
everything that follows.

### Configuration

| | |
|---|---|
| Database strategy | `pg.Client` — one connection opened at boot |
| API replicas | 1 |
| Load balancer | nginx, default configuration |
| CPU/memory limits | none |
| Indexes | primary key and `UNIQUE` on `apelido` only |
| Runs | 2 independent, metrics within 1% of each other |

### Statistics

| Metric | Value |
|---|---|
| **Requests** | 93,581 |
| **Success** | 55,775 — **59.60%** |
| Failures | 37,806 |
| **People created** | **25,166** |
| Lost writes | 0 |
| **p50** | **1 ms** |
| p75 | 538 ms |
| p95 | 1,264 ms |
| **p99** | **1,486 ms** |
| max | 1,677 ms |
| mean | 257 ms |
| **Peak throughput at 100% success** | **610 req/s** |
| Throughput at p50 ≤ 20 ms | 577 req/s |
| Mean useful throughput | 272 req/s |
| **Breaking point** | **t=113s — 371 users/s injected** |
| Degradation starts | t=107s |
| Peak concurrency | 272 simultaneous |
| Throughput in the last 60s | 237 req/s (−61% from the peak) |

### Per endpoint

| Endpoint | Requests | OK | KO | p50 | p99 | Cost in Postgres |
|---|---|---|---|---|---|---|
| criação | 54,635 | 29,473 | 25,162 | 1 ms | 1,497 ms | 0.25 ms (Insert) |
| consulta | 25,166 | 18,707 | 6,459 | 2 ms | 1,442 ms | 0.14 ms (Index Scan) |
| busca válida | 9,590 | 5,262 | 4,328 | 7 ms | 1,518 ms | **57.57 ms (Seq Scan)** |
| busca inválida | 4,190 | 2,333 | 1,857 | 1 ms | 5 ms | never touches the database |

### Diagnosis

**Bottleneck: the `Seq Scan` behind the search.** The `ILIKE '%term%'` with a
leading wildcard cannot use a B-tree index and scans the whole table — 57.57 ms
at 25 thousand rows, about 400× the cost of the other queries. Since the
connection is single and serializes everything, that cost dominates, and it
**gets worse during the run**: every successful creation makes the following
searches more expensive.

| Moment | rows | scan cost | share of the connection's time | capacity |
|---|---|---|---|---|
| t=50s | 1,207 | 2.8 ms | 44% | ~1,430 q/s |
| t=110s | 10,932 | 25.0 ms | **85%** | ~370 q/s |
| t=200s | 24,503 | 56.1 ms | **93%** | ~180 q/s |

The search is 8.9% of the queries and consumes 85% of the connection at the
moment it breaks. Load rises while capacity falls; the breaking point is where
the curves cross.

**But the failures happened in nginx.** The database latency inflated
concurrency (`L = λ × W`) until it exhausted the default worker's 512 slots — as
a proxy, each request occupies two slots, so the real ceiling is 256 simultaneous.
Concurrency crossed that limit at t=113s, exactly the second of the first
failure, and stayed pinned at 262–265 for the remaining 90 s even as injection
doubled.

```
expensive Seq Scan → high latency → concurrency inflates
                   → 512 slots exhausted → nginx closes the socket
```

nginx is **where** the system broke; the missing index is **why**.

Three pieces of evidence support this:

- **The 37,806 KOs have not a single line of access log** and carry a single
  message on the client, `Premature close`. There is no `502`, `504` or `503` —
  the connections died before nginx allocated a slot. `busca inválida`, which
  answers `400` without touching the database, had a p99 of 5 ms and still 44%
  failures.
- **With healthy latency the limit would never be reached.** At t=106s, `W = 23 ms`
  and concurrency was 8. Projecting that W to the peak of 722 u/s: 17 users,
  34 slots — 15× of headroom.
- **The three endpoints that touch the database converged on ~270 ms mean**,
  despite real costs of 0.14 / 0.25 / 57.57 ms. The latency does not come from
  the work, it comes from the queue: the `_queryQueue` of `pg.Client` dispatches
  one query at a time. `criação` has a p50 of 1 ms and a p75 of 561 ms — a cliff,
  not a curve: two populations, empty queue and full queue, nothing in between.

### Next step

Three fixes attack different things and must be measured separately:

- **API replicas** (approach 2) — more processes, more connections, but the cost
  of each scan stays the same.
- **Connection pool** — does not make the scan cheaper, it lets it happen in
  parallel. Solves head-of-line blocking.
- **`pg_trgm` + GIN index** — removes the work instead of parallelizing it.
  Attacks the root cause.

---

## Approach 2 — single connection, 2 replicas

```
nginx (1 worker, 512 slots, round-robin)
  ├── api1 ── 1 Node process ── 1 connection ─┐
  └── api2 ── 1 Node process ── 1 connection ─┴── Postgres
```

Same code as approach 1: each process still holds **one** `pg.Client` connection.
The only variable changed is the replica count — nginx now spreads the load
between `api1` and `api2` in round-robin. Two independent queues of depth 1
instead of one.

### Configuration

| | |
|---|---|
| Database strategy | `pg.Client` — one connection per process |
| API replicas | 2 |
| Load balancer | nginx, round-robin upstream |
| CPU/memory limits | none |
| Indexes | primary key and `UNIQUE` on `apelido` only |

### Prediction recorded before the run

Search cost measured with `EXPLAIN ANALYZE` over the 32,111 rows left behind by
approach 2, before and after the index:

| Term | `Seq Scan` | GIN trigram | Gain |
|---|---|---|---|
| nonexistent | 63.08 ms | **0.12 ms** | **525×** |
| `Node` | 55.05 ms | **0.16 ms** | 344× |
| `ana` | 27.39 ms | **0.30 ms** | 92× |

Predictions: the breaking point should disappear or move very close to the end;
if it persists, the bottleneck has moved elsewhere. Only ~4% of the searches
(terms of 1–2 characters, which produce no trigram) should fall back to
`Seq Scan`. And the GIN index should make `INSERT` more expensive — if write
throughput drops, the cost showed up.

**Result: two right, one wrong.** The sustained breaking point disappeared and
writes got 3.2× more expensive, as predicted. The 4% of `Seq Scan` turned out to
be 55% — see below.

### Statistics

| Metric | Value | vs. approach 1 |
|---|---|---|
| **Requests** | 100,518 | +7.4% |
| **Success** | 74,875 — **74.49%** | +14.9 p.p. |
| Failures | 25,643 | −32.2% |
| **People created** | **32,111** | **+27.6%** |
| Lost writes | 0 | = |
| **p50** | **1 ms** | = |
| p75 | 100 ms | −81% |
| p95 | 1,240 ms | −2% |
| **p99** | **1,576 ms** | +6% |
| max | 1,976 ms | +18% |
| mean | 184 ms | −28% |
| **Peak throughput at 100% success** | **745 req/s** | **+22%** |
| Throughput at p50 ≤ 20 ms | 700 req/s | +21% |
| Mean useful throughput | 360 req/s | +32% |
| **Breaking point** | **t=135s — 459 users/s injected** | **+22 s / +24%** |
| Degradation starts | t=125s | +18 s |
| Peak concurrency | 254 simultaneous | −7% |
| Throughput in the last 60s | 400 req/s (−46% from the peak) | +69% |

### Per endpoint

| Endpoint | Requests | OK | KO | p50 | p99 | Cost in Postgres |
|---|---|---|---|---|---|---|
| criação | 54,627 | 37,614 | 17,013 | 1 ms | 1,583 ms | 0.24 ms (Insert) |
| consulta | 32,111 | 27,649 | 4,462 | 4 ms | 1,569 ms | 0.15 ms (Index Scan) |
| busca válida | 9,590 | 6,676 | 2,914 | 15 ms | 1,625 ms | **65.10 ms (Seq Scan)** |
| busca inválida | 4,190 | 2,936 | 1,254 | 1 ms | 5 ms | never touches the database |

Costs measured with `EXPLAIN ANALYZE` at the end of the run, with the table at
32,111 rows.

### Diagnosis

**The ~2× prediction was wrong. The measured gain was ~22%.** It is worth
understanding why, because the error is instructive.

Doubling the replicas doubled the parallelism — two queues of depth 1 instead of
one. But **the scan did not get cheaper, and the run lasted longer**: the extra
22 seconds of survival were spent inserting rows into the table the scan sweeps.

| | breaking point | rows in the table | scan cost | connections | relative capacity |
|---|---|---|---|---|---|
| Approach 1 | t=113s | 11,401 | ~23 ms | 1 | 1.00× |
| Approach 2 | t=135s | 17,532 | ~36 ms | 2 | **1.28×** |

`2 connections × (23 ms / 36 ms) = 1.28×` — predicted +28%, measured +22%. The
parallelism doubled and the work got 53% more expensive over the same interval,
and what was left is the difference.

**This is the signature of a bottleneck that does not scale horizontally:** each
additional replica accepts more writes, and each write makes the `Seq Scan` of
every replica more expensive. The gain from adding replicas is sublinear and
keeps shrinking. The per-row cost of the scan, incidentally, did not change —
65.10 ms / 32,111 rows = 2.0 µs per row, against 2.3 µs in approach 1. Only the
table grew.

**The wall is still the same: the 512 nginx slots.** Concurrency pins at 254
simultaneous — 508 of the 512 available slots, since each proxied request takes
two. The first failure came at t=135.8s, with ~235 simultaneous.

```
expensive Seq Scan → high latency → concurrency inflates
                   → 512 slots exhausted → nginx refuses
```

**New this round: 302 `500` responses.** In approach 1, 100% of the failures were
invisible — connections dead before nginx allocated any slot. Now a fraction of
the exhaustion became visible: the error log carries **298 occurrences of
`worker_connections are not enough while connecting to upstream`**, against
24,163 of the same warning without the suffix. That is, nginx accepted the client
and only then discovered it had no slot for the upstream, answering `500`. Same
exhaustion, two different moments.

The reconciliation closes exactly:

```
Gatling KO                        : 25,643
  ├─ Premature close              : 25,341   ← refused at accept
  └─ status 500                   :    302   ← refused when connecting upstream

nginx served                      : 75,177 = 74,875 OK + 302 five-hundreds
never reached nginx               : 25,341 = 100,518 − 75,177
rows in Postgres                  : 32,111 = `consulta` requests
```

Zero lost writes: every `201` became a row, every row became a `consulta`.

**The queueing signal is still there, but weaker.** The per-endpoint means still
converge despite real costs that differ by 400× — 184 ms on creation, 199 ms on
fetch, 211 ms on search — but the p75 of creation dropped from 538 ms to 94 ms.
The cliff between "empty queue" and "full queue" is still there; it just got
shallower, because now there are two queues to fall into.

### Next step

Approach 2 bought time without touching the cause. The two remaining fixes still
apply, and now with a better calibrated prediction:

- **Connection pool** — same nature as the replica: it parallelizes without
  making anything cheaper. It should yield more than the replicas (dozens of
  connections, not two), but it runs into the same moving ceiling: the more
  writes get through, the more expensive each scan becomes. Prediction:
  sublinear gain in the number of connections, breaking point pushed to
  t≈150–170s, nginx wall still present.
- **`pg_trgm` + GIN index** — the only fix that attacks the `Seq Scan` instead of
  parallelizing it. Prediction: this is the one that should change the shape of
  the curve, not just its position.

---

## Approach 3 — single connection, 1 replica, GIN + `pg_trgm` index

```
nginx (1 worker, 512 slots)
  └── api1 ── 1 Node process ── 1 connection ── Postgres (GIN trigram)
```

Back to the topology of approach 1 — one replica, one connection — to isolate the
only variable that matters now: **the index**. Instead of parallelizing the
`Seq Scan`, the goal is to make it disappear.

`ILIKE '%term%'` with a leading wildcard cannot use a B-tree, but it can use a
**trigram index**. Since `ARRAY_TO_STRING` is not `IMMUTABLE`, Postgres refuses to
index the expression directly; the fix is to materialize the three searchable
fields into a generated column and index that column:

```sql
CREATE EXTENSION pg_trgm;

busca TEXT GENERATED ALWAYS AS (busca_texto(apelido, nome, stack)) STORED

CREATE INDEX idx_pessoas_busca ON pessoas USING GIN (busca gin_trgm_ops);
```

The search query drops its three `OR`s and becomes `WHERE busca ILIKE $1`.

### Configuration

| | |
|---|---|
| Database strategy | `pg.Client` — one connection opened at boot |
| API replicas | 1 |
| Load balancer | nginx, single upstream |
| CPU/memory limits | none |
| Indexes | primary key, `UNIQUE` on `apelido` and **GIN `gin_trgm_ops` over `busca`** |

### Statistics

| Metric | Value | vs. approach 1 |
|---|---|---|
| **Requests** | 111,263 | +18.9% |
| **Success** | 104,160 — **93.62%** | **+34.0 p.p.** |
| Failures | 7,103 | −81.2% |
| **People created** | **42,851** | **+70.3%** |
| Lost writes | 0 | = |
| **p50** | **1 ms** | = |
| p75 | 10 ms | −98% |
| p95 | 517 ms | −59% |
| **p99** | **733 ms** | **−51%** |
| max | 1,014 ms | −40% |
| mean | 64 ms | −75% |
| **Peak throughput at 100% success** | **1,257 req/s** | **+106%** |
| Throughput at p50 ≤ 20 ms | 1,399 req/s | +142% |
| Mean useful throughput | 503 req/s | +85% |
| **First failure** | **t=137s — 467 users/s** | +24 s / +26% |
| Sustained breaking point | **none** | — |
| Peak concurrency | 258 simultaneous | −5% |
| Throughput in the last 60s | 866 req/s (−38% from the peak) | +265% |

### Per endpoint

| Endpoint | Requests | OK | KO | p50 | p99 | Cost in Postgres |
|---|---|---|---|---|---|---|
| criação | 54,632 | 50,241 | 4,391 | 1 ms | 754 ms | 0.77 ms (Insert + GIN) |
| consulta | 42,851 | 41,245 | 1,606 | 1 ms | 693 ms | 0.15 ms (Index Scan) |
| busca válida | 9,590 | 8,812 | 778 | 6 ms | 765 ms | **0.21 ms (Bitmap Index Scan)** |
| busca inválida | 4,190 | 3,862 | 328 | 1 ms | 6 ms | never touches the database |

Costs measured with `EXPLAIN ANALYZE` at the end of the run, with the table at
42,851 rows.

### Diagnosis

**The bottleneck was eliminated, and this time the curve changed shape — not just
position.**

The search cost 63.08 ms in approach 2. Now it costs **0.21 ms**, with a table 33%
larger. That is the end of the `Seq Scan` as the dominant factor.

But that is not the number that matters. This is:

| Third of the run | Approach 1 | Approach 2 | **Approach 3** |
|---|---|---|---|
| start (t=0–69s) | 116 req/s | 128 req/s | **110 req/s** |
| middle (t=69–138s) | 448 req/s | 561 req/s | **546 req/s** |
| end (t=138–207s) | 253 req/s | 391 req/s | **854 req/s** |

In the first two approaches the last third was **the worst** — throughput
collapsed exactly when the load was highest, because every inserted row made all
subsequent searches more expensive. Here the last third is the **best**. Capacity
stopped decaying during the run.

This is confirmed at the most unlikely point: **the peak throughput at 100%
success, 1,257 req/s, happened at t=205s** — the second-to-last second of the
test, with a full table. In approaches 1 and 2 the clean peak happened before the
break and never came back.

**Failure stopped being a collapse and became a sawtooth.** There was no sustained
breaking point — the script that looks for 6 consecutive seconds of failure found
none:

| | Approach 1 | Approach 2 | **Approach 3** |
|---|---|---|---|
| seconds with failures | 95 of 208 | 73 of 208 | **33 of 207 (16%)** |
| longest consecutive streak | until the end | until the end | **4 seconds** |
| recovers to zero failures? | no | no | **yes, up to 10 clean seconds in a row** |

In the clean seconds after the first failure, the system delivered **968 req/s on
average**. That is: it saturates for 2–4 seconds, drains the queue, and returns to
normal. The p50 never stayed above 20 ms for 5 seconds in a row.

### The 4% prediction was off by a lot

I recorded that only 4% of the searches would fall back to `Seq Scan` (terms of
1–2 characters, which produce no trigram). `pg_stat_user_tables` says otherwise:

```
seq_scan  : 4,868      ← 55% of the searches
idx_scan  : 3,950      ← 45% of the searches
```

**The reason is not a limitation of the index, it is the planner's cost
decision.** When the term is common, the `LIMIT 50` is satisfied after a few
hundred rows, and scanning is cheaper than consulting the index. Postgres picks
the plan by selectivity estimate, not by term length.

And it works: even with half the searches scanning, the search p99 dropped from
1,518 ms to 765 ms. The index did not have to serve every search — it had to
serve the **expensive** ones, which were exactly the rare-term searches that swept
the entire table.

### The price paid

Both predicted costs showed up, and both were worth it:

| | Before | After |
|---|---|---|
| `INSERT` cost | 0.24 ms | **0.77 ms** (3.2×) |
| disk space | — | **19 MB** (10× the primary key, which takes 1.8 MB) |

Writes got 3× more expensive and successful creations still went from 29,473 to
**50,241**. What was gained by not blocking the queue paid for the index
maintenance cost with room to spare.

### The wall is still nginx

The 7,103 KOs carry a single message, `Premature close`, and the error log brings
6,762 `worker_connections are not enough` warnings — none of them with the
`while connecting to upstream` suffix, and zero `500` responses. Concurrency still
touches 258 simultaneous (516 of the 512 slots).

The difference is duration: before, concurrency pinned at the ceiling and stayed
there for the remaining 90 seconds; now it touches, the system drains, and it
falls back to zero.

The reconciliation closes exactly:

```
Gatling KO        : 7,103 = 111,263 − 104,160, all Premature close
nginx access log  : 104,160 OK (+12 malformed lines)
status 201        : 42,851 = rows in Postgres = `consulta` requests
status 400        :  4,183 = 3,862 from `busca inválida` + 321 from `criação`
```

### Next step

With the `Seq Scan` out of the way, two bottleneck candidates remain, and they can
now be measured separately:

- **The single connection** — still serializes everything. A pool should attack
  the 2–4 second spikes that still saturate nginx.
- **The 512 nginx slots** — now that latency has dropped, the ceiling may be
  reached by legitimate throughput rather than by an inflated queue. It is the
  first time it makes sense to touch the nginx configuration.

And the **compliance approach** is still pending: 2 replicas and limits of
1.5 CPU / 3.0 GB, which is what the Rinha rules require and which none of the
three approaches so far has respected.

---

## Approach 4 — 2 replicas, GIN + `pg_trgm` index

```
nginx (1 worker, 512 slots, round-robin)
  ├── api1 ── 1 Node process ── 1 connection ─┐
  └── api2 ── 1 Node process ── 1 connection ─┴── Postgres (GIN trigram)
```

Keeps the index from approach 3 and brings back the second replica. One variable
changed.

This approach is the **test of approach 2's diagnosis**. There, doubling the
replicas yielded only +22% instead of the expected 2×, and the recorded
explanation was that the `Seq Scan` got more expensive as the run went on — the
parallelism doubled, but the work grew alongside it. If that explanation is right,
now that the `Seq Scan` is out of the way **the second replica should yield much
more than it did before**.

It is also the first approach that satisfies the Rinha requirement of two API
instances. It still violates the rules on CPU and memory limits.

### Configuration

| | |
|---|---|
| Database strategy | `pg.Client` — one connection per process |
| API replicas | 2 |
| Load balancer | nginx, round-robin upstream |
| CPU/memory limits | none |
| Indexes | primary key, `UNIQUE` on `apelido` and GIN `gin_trgm_ops` over `busca` |

### Statistics

| Metric | Value | vs. approach 3 |
|---|---|---|
| **Requests** | 114,963 | +3.3% |
| **Success** | 114,914 — **99.96%** | **+6.3 p.p.** |
| Failures | **49** | **−99.3%** |
| **People created** | **46,549** | +8.6% |
| Lost writes | 0 | = |
| **p50** | **1 ms** | = |
| p75 | 2 ms | −80% |
| p95 | 45 ms | −91% |
| **p99** | **212 ms** | **−71%** |
| max | 377 ms | −63% |
| mean | 10 ms | −84% |
| **Peak throughput at 100% success** | **1,256 req/s** | = |
| Throughput at p50 ≤ 20 ms | 1,256 req/s | −10% |
| Mean useful throughput | 555 req/s | +10% |
| **Seconds with failures** | **1 of 207** | 33 of 207 |
| Sustained breaking point | none | none |
| Median concurrency (last third) | **2 simultaneous** | 20 |
| Peak concurrency | 250 simultaneous | 258 |
| Throughput in the last 60s | 1,030 req/s (−18% from the peak) | +19% |

### Per endpoint

| Endpoint | Requests | OK | KO | p50 | p99 | Cost in Postgres |
|---|---|---|---|---|---|---|
| criação | 54,634 | 54,604 | 30 | 1 ms | 217 ms | 0.82 ms (Insert + GIN) |
| consulta | 46,549 | 46,535 | 14 | 1 ms | 207 ms | 0.15 ms (Index Scan) |
| busca válida | 9,590 | 9,586 | 4 | 5 ms | 235 ms | 0.13 ms (Bitmap Index Scan) |
| busca inválida | 4,190 | 4,189 | 1 | 1 ms | 6 ms | never touches the database |

Costs measured with `EXPLAIN ANALYZE` at the end of the run, with the table at
46,549 rows.

### Diagnosis

**99.96% success, with the failures concentrated in a single second of the run.**

All 49 failures happened at t=171s, in an isolated spike where concurrency jumped
to 239 simultaneous (478 slots). All with the same message, `Premature close`, and
the `worker_connections` warnings in nginx dropped from 6,762 to **31**. In the
other 206 seconds, zero failures.

The p50 never went above 125 ms in any second — against 759 ms in approach 3.

### The prediction was right, and by a wider margin

I predicted concurrency would drop to around 130 simultaneous, about half the
nginx ceiling. The result was much better:

| Last third of the run (t=138–207s) | Approach 3 | **Approach 4** |
|---|---|---|
| median concurrency | 20 | **2** |
| mean concurrency | 98 | **14** |
| p95 concurrency | 255 | **90** |
| slots used (median) | 40 of 512 | **4 of 512** |
| median per-second p50 | 11.5 ms | **1.0 ms** |
| worst second (p50) | 759 ms | **125 ms** |

The second queue draining in parallel did not halve concurrency — it cut it by
**10×**. The reason is that `L = λ × W` feeds back on itself: when the queue
drains faster, latency drops, and lower latency means fewer requests coexisting,
which makes the queue drain faster still. The effect is multiplicative as long as
the system stays out of saturation.

### The 2× question could not be answered

Approach 4 was the test of approach 2's diagnosis: without the `Seq Scan` getting
more expensive, the second replica should yield close to 2× instead of the 1.28×
measured there. **The test did not allow that to be measured.**

| | Approach 3 | Approach 4 |
|---|---|---|
| Peak throughput at 100% success | 1,257 req/s | 1,256 req/s |
| Second it happened | t=205s | t=205s |
| Injection in that second | 740 u/s (maximum) | 740 u/s (maximum) |

Both approaches reached the same number, in the same second — the **last** one of
the run, when the Gatling ramp hits its ceiling of 740 users/s. That is neither
coincidence nor a tie: both delivered everything that was offered.

**The throughput limiter stopped being the system and became the test.** From
approach 3 onward, "peak throughput at 100% success" stopped measuring capacity
and started measuring the Gatling ramp. That is why the replica's gain shows up in
the concurrency and latency tables and not in the throughput one: there was
capacity left over that the load never exercised.

This applies to **throughput**, not to the whole system.
[Approach 6](#approach-6--connection-pool-pgpool) later showed there was still a
real bottleneck here — the concurrency spikes of the single connection, which
drove the nginx slots to 500 of 512 and produced the 49 failures. It did not show
up in throughput because it did not limit throughput; it limited the tail.

Throughput per third shows the same thing from another angle — the system tracks
the load from start to finish, with no inflection:

| Third | Appr. 1 | Appr. 2 | Appr. 3 | **Appr. 4** |
|---|---|---|---|---|
| start | 116 req/s | 128 req/s | 110 req/s | **111 req/s** |
| middle | 448 req/s | 561 req/s | 546 req/s | **551 req/s** |
| end | 253 req/s | 391 req/s | 854 req/s | **1,003 req/s** |

### The index still has half the searches on `Seq Scan`

Same pattern as approach 3, and for the same reason — the planner chooses to scan
when the term is common and the `LIMIT 50` is satisfied early:

```
seq_scan            : 4,914   (51%)
idx_pessoas_busca   : 4,678   (49%)   —  20 MB
```

The `INSERT` cost settled at 0.82 ms, against 0.24 ms without the index.

The reconciliation closes exactly:

```
Gatling KO   :     49, all Premature close, all at t=171s
status 201   : 46,549 = rows in Postgres = `consulta` requests
status 400   :  4,537 = 4,189 from `busca inválida` + 348 from `criação`
status 200   : 56,124 = 56,121 from the test + 3 `contagem-pessoas` calls
```

### Next step

The system left the zone where this test can measure it. To get an observable
bottleneck back, the way forward is to **apply the Rinha restrictions**: 1.5 CPU
and 3.0 GB split across the four containers.

With 1.5 CPU in total instead of the machine's 12, the bottleneck should
reappear — and probably somewhere else, since neither the `Seq Scan` nor the
single-connection queue is dominant any more. It is also the first configuration
that would be valid under the tournament rules.

---

## Approach 5 — connection per request (`try/finally`)

```
nginx (round-robin)
  ├── api1 ──┐
  └── api2 ──┴── N ephemeral connections ── Postgres (GIN trigram, max_connections=100)
```

Keeps everything from approach 4 and changes only the connection strategy.
Instead of one connection opened at boot and reused forever, each `query()` call
opens its own connection and closes it in the `finally`:

```js
export async function query(text, params) {
  const client = new Client({ ... });

  try {
    await client.connect();
    return await client.query(text, params);
  } finally {
    await client.end();
  }
}
```

Two opposite consequences, and the tension between them is what the test will
settle:

- **Head-of-line blocking disappears.** There is no single queue any more: each
  request has its own connection and the queries genuinely run in parallel.
- **Each request pays to open and close a connection** — TCP handshake,
  authentication, and a fresh process forked by Postgres.

The `await` before `client.query` is mandatory. Without it, the `finally` would
run before the query resolved and would close the connection midway.

**About the `catch`:** I let the error propagate instead of catching it here. The
`POST /pessoas` handler already has its own `catch`, and that is what turns a
`UNIQUE` violation into a `422`. A `catch` that swallowed the error inside
`query()` would break that path — the handler would receive `undefined` and blow
up reading `result.rows[0]`.

### Configuration

| | |
|---|---|
| Database strategy | `pg.Client` — one connection per request, closed in the `finally` |
| API replicas | 2 |
| Load balancer | nginx, round-robin upstream |
| CPU/memory limits | none |
| Indexes | primary key, `UNIQUE` on `apelido` and GIN `gin_trgm_ops` over `busca` |
| Postgres `max_connections` | 100 (default) |

### Statistics

| Metric | Value | vs. approach 4 |
|---|---|---|
| **Requests** | 114,085 | −0.8% |
| **Success** | 113,521 — **99.51%** | −0.45 p.p. |
| Failures | **564** | +1,051% |
| **People created** | **45,660** | **−889** |
| Silently lost writes | **71** | 0 |
| **p50** | **5 ms** | **5×** |
| p75 | 14 ms | 7× |
| p95 | 103 ms | 2.3× |
| **p99** | **203 ms** | −4% |
| max | 679 ms | +80% |
| mean | 21 ms | 2.1× |
| **Peak throughput at 100% success** | 1,263 req/s | = |
| Mean useful throughput | 548 req/s | −1% |
| **Seconds with failures** | **11 of 207** | 1 of 207 |
| First failure | t=187s — 664 users/s | t=171s |
| Median concurrency (last third) | 9 simultaneous | 2 |
| Peak concurrency | **198 simultaneous** | 250 |
| nginx `worker_connections` warnings | **0** | 31 |
| Throughput in the last 60s | 1,011 req/s | −2% |

### Per endpoint

| Endpoint | Requests | OK | KO | p50 | p99 | Note |
|---|---|---|---|---|---|---|
| criação | 54,645 | 54,645 | **0** | 5 ms | 208 ms | zero failures — see below |
| consulta | 45,660 | 45,272 | 388 | 5 ms | 199 ms | `500` from lack of connections |
| busca válida | 9,590 | 9,414 | 176 | 13 ms | 211 ms | `500` from lack of connections |
| busca inválida | 4,190 | 4,190 | 0 | 1 ms | **37 ms** | never touches the database |

### Diagnosis

**Both predictions were confirmed, and the second one is the more interesting.**

Postgres logged **635 `FATAL: sorry, too many clients already`**. Concurrency
reached 198 requests in flight, each holding its own connection, against a ceiling
of 100. The failures were all concentrated in the last 20 seconds of the run, when
injection passed 660 users/s.

### The same error, two different reports

The 635 connection errors split like this:

```
635 FATAL: sorry, too many clients already
├── 564 on the GET routes  → became 500   (no try/catch, Express propagates)
└──  71 on the POST route  → became 422   (the handler's catch swallowed it)
```

The `criação` endpoint finished the run with **zero failures** according to
Gatling — and with 71 fewer people than it should have. `422` is an expected
response in the test, so nobody counted it as an error. **The write was lost
without leaving a trace in the HTTP status.**

That was exactly the trap recorded in the prediction. The `POST /pessoas` `catch`
returns `422` for any error, and up to approach 4 that was harmless because the
only possible error was a `UNIQUE` violation. As soon as a second failure mode
came into existence, the handler started reporting an infrastructure problem as a
validation error.

The run's `422`s decompose like this:

```
8,637 responses with 422
├── 5,655  pure validation (missing field, invalid date) — never touch the database
├── 1,780  duplicate apelido
├── 1,131  value longer than the column limit
└──    71  connection failure  ← masked
```

### The nginx wall is gone

Zero `worker_connections` warnings — against 6,762 in approach 3 and 31 in
approach 4. The bottleneck migrated from the load balancer to the Postgres
`max_connections`. It is the first approach in the series where nginx does not
appear in the diagnosis.

### The handshake cost showed up where there is no database

The global p50 went from 1 ms to 5 ms, consistent with the 2.6 ms of measured
per-request overhead. But the number that best explains what happened is this one:

| `busca inválida` | Approach 4 | Approach 5 |
|---|---|---|
| p99 | 6 ms | **37 ms** |

That endpoint answers `400` at the handler's first `if`, with no `await` and
without touching the database. It got **6× slower** while doing no I/O at all —
because the Node event loop is busy opening and closing about 1,200 connections
per second. The cost of a connection is not contained within the request that
opened it; it contaminates every other request sharing the process.

### The trade did not pay off, and the reason is the order of the experiments

Connection per request eliminates head-of-line blocking — each request genuinely
runs in parallel, with no queue. That was the central problem of approach 1, where
the queue accounted for more than 99% of the latency.

**But that problem no longer existed.** The GIN index made the queries so cheap
(0.13 ms on search) that the single-connection queue stopped being a bottleneck —
approach 4 ran with median concurrency of 2 and a p50 of 1 ms. There was no queue
left to eliminate.

The result is a trade with nothing on the other side:

| | Approach 4 | Approach 5 |
|---|---|---|
| p50 | 1 ms | 5 ms |
| p95 | 45 ms | 103 ms |
| People created | 46,549 | 45,660 |
| Failures | 49 | 564 |
| Parallelism gain | — | irrelevant |

The lesson is not that connection per request is bad in every situation — it is
that **the same change has opposite signs depending on where the bottleneck is**.
Applied in approach 1, it would probably have helped a great deal. Applied after
the index, it only charged the price.

The reconciliation closes exactly:

```
Gatling KO       :    564, all 500, all in the last 20 seconds
status 201       : 45,660 = rows in Postgres = `consulta` requests
status 500       :    564 = 388 from `consulta` + 176 from `busca válida`
status 400       :  4,538 = 4,190 from `busca inválida` + 348 from `criação`
status 200       : 54,689 = 54,686 from the test + 3 `contagem-pessoas` calls
FATAL in Postgres:    635 = 564 that became 500 + 71 that became 422
```

### Next step

With head-of-line blocking already solved by the index, the natural path is the
**connection pool** — which sits between the two strategies already measured: it
reuses connections like the shared `pg.Client`, but with more than one, and with a
configurable ceiling that prevents blowing past `max_connections`.

And the **compliance approach** with 1.5 CPU and 3.0 GB is still pending, which is
the only way to get back a bottleneck this test can measure.

---

## Approach 6 — connection pool (`pg.Pool`)

```
nginx (round-robin)
  ├── api1 ── pool of up to 10 connections ─┐
  └── api2 ── pool of up to 10 connections ─┴── Postgres (GIN trigram, max_connections=100)
```

Third and last connection strategy of the series. It is the exact middle ground
between the two already measured: it reuses connections like the shared
`pg.Client`, but keeps several instead of one.

```js
const pool = new Pool({ ... });

export async function query(text, params) {
  return pool.query(text, params);
}
```

`pool.query()` takes a free connection, runs the query and returns it to the pool
automatically. There is no per-request `connect` or `end` — and therefore no
`try/finally`: there is no resource to release by hand.

The pool is **lazy**: it opens connections on demand up to the ceiling and keeps
them open after that. Measured at rest after boot: **1 connection**. After 30
concurrent requests: **4 connections**. It grows as far as the load demands.

**Pool size: the `pg` default, which is 10 per process.** I deliberately left it
unconfigured, so that the only variable this round is the connection strategy.
With 2 replicas the aggregate ceiling is 20 connections — well below the
`max_connections = 100` that approach 5 blew past.

### Configuration

| | |
|---|---|
| Database strategy | `pg.Pool` — up to 10 connections per process, driver default |
| API replicas | 2 |
| Load balancer | nginx, round-robin upstream |
| CPU/memory limits | none |
| Indexes | primary key, `UNIQUE` on `apelido` and GIN `gin_trgm_ops` over `busca` |
| Postgres `max_connections` | 100 (default) |
| Aggregate connection ceiling | 20 of 100 |

### Statistics

| Metric | Value | vs. approach 4 |
|---|---|---|
| **Requests** | 115,000 | +0.03% |
| **Success** | 115,000 — **100.00%** | +0.04 p.p. |
| **Failures** | **0** | 49 |
| **People created** | **46,580** | +31 |
| Lost writes | 0 | = |
| **p50** | **1 ms** | = |
| p75 | 1 ms | −50% |
| p95 | 6 ms | **−87%** |
| **p99** | **20 ms** | **−91%** |
| max | **117 ms** | −69% |
| mean | 2 ms | −80% |
| **Peak throughput** | 1,267 req/s ¹ | = |
| Mean useful throughput | 556 req/s | +0.2% |
| **Seconds with failures** | **0 of 207** | 1 of 207 |
| Median concurrency (last third) | **1 simultaneous** | 2 |
| **Peak concurrency** | **29 simultaneous** | 250 |
| nginx slots at the peak | **58 of 512** | 500 of 512 |
| `worker_connections` warnings | **0** | 31 |
| Throughput in the last 60s | 1,034 req/s | +0.4% |

### Per endpoint

| Endpoint | Requests | OK | KO | p50 | p99 | Cost in Postgres |
|---|---|---|---|---|---|---|
| criação | 54,640 | 54,640 | 0 | 1 ms | **9 ms** | 0.82 ms (Insert + GIN) |
| consulta | 46,580 | 46,580 | 0 | 1 ms | **5 ms** | 0.15 ms (Index Scan) |
| busca válida | 9,590 | 9,590 | 0 | 4 ms | **37 ms** | 0.13 ms (Bitmap Index Scan) |
| busca inválida | 4,190 | 4,190 | 0 | 1 ms | 7 ms | never touches the database |

### Diagnosis

**100.00% success — 115,000 requests, zero failures.** The first and only approach
in the series without a single error, in any second of the run.

Postgres logged no `too many clients`, and nginx emitted not a single
`worker_connections` warning. The two ceilings that appeared in the previous
approaches stayed out of reach by a wide margin.

### The prediction was wrong on the part that mattered

I recorded that "against approach 4 the gain should be small", because it already
ran with median concurrency of 2 and a p50 of 1 ms — there was almost no queue for
the pool to eliminate. **The median indeed did not change. The mistake was
assuming that made the gain small.**

| Last third (t=138–207s) | Approach 4 | Approach 5 | **Approach 6** |
|---|---|---|---|
| median concurrency | 2 | 9 | **1** |
| p95 concurrency | 90 | 149 | **4** |
| peak concurrency | 250 | 198 | **29** |
| median per-second p50 | 1.0 ms | 8.0 ms | **1.0 ms** |
| **worst second (p50)** | **125 ms** | 175 ms | **1.0 ms** |

The median was the same in both. What separated approach 4 from total success were
the **spikes** — and that is where 100% of the failures lived, along with every
nginx warning and the p99 of 212 ms.

The pool did not improve the common case; it **eliminated the worst case**. The
p50 of the worst second of the run dropped from 125 ms to 1 ms: there is no "worst
second" any more. The distribution went flat.

This shows the limit of reasoning by medians. A median concurrency of 2 said
"there is no queue", and it was right — at the median. But 5% of the time the
queue reached 90 requests, and that is what produces a bad p99 and failures. **A
measure of central tendency cannot predict behavior in the tail.**

### What happened to head-of-line blocking

The shared `pg.Client` dispatches one query at a time. While the load is light,
this does not show — the queue drains between arrivals. In a spike, requests
arrive faster than the single connection can dispatch, the queue grows, latency
rises, and by `L = λ × W` concurrency rises with it, until it touches the 512
nginx slots.

With 10 connections per process, the spike is absorbed: **peak concurrency dropped
from 250 to 29**, and slots used from 500 to 58 — from 98% of the nginx ceiling to
11%. The entire chain that had been producing failures since approach 1 ceased to
exist.

It is worth noting how much of this is unused reserve: the aggregate ceiling was
20 connections and peak concurrency was 29 requests in flight. **The pool never
came close to its own limit** — the queue it had to absorb was much smaller than
its capacity.

### Comparing the three connection strategies

All three ran with 2 replicas and the same index. The only variable was how the
connection is obtained:

| | shared `Client` | connection per request | **`Pool` (10/proc)** |
|---|---|---|---|
| Approach | 4 | 5 | **6** |
| Success | 99.96% | 99.51% | **100.00%** |
| p50 | 1 ms | 5 ms | **1 ms** |
| p99 | 212 ms | 203 ms | **20 ms** |
| Failures | 49 | 564 | **0** |
| Lost writes | 0 | 71 | **0** |
| Bottleneck reached | nginx slots | `max_connections` | **none** |

The two alternatives failed for opposite reasons — the single connection from a
shortage of parallelism during spikes, the connection per request from an excess
of connections. The pool sits in the middle: it reuses like the first,
parallelizes like the second, and has a configurable ceiling that prevents the
second one's runaway.

**The driver default was enough.** I did not configure `max`, `idleTimeoutMillis`
or `connectionTimeoutMillis` — the 10 per process of the `pg` default already left
the system with 3× of headroom over the observed peak.

The reconciliation closes exactly:

```
Gatling KO       :      0
status 201       : 46,580 = rows in Postgres = `consulta` requests
status 400       :  4,538 = 4,190 from `busca inválida` + 348 from `criação`
status 422       :  7,712 = 1,834 duplicates + 1,150 too-long values + 4,728 validation
status 200       : 56,173 = 56,170 from the test + 3 `contagem-pessoas` calls
errors in Postgres:     0 connection errors
```

### Next step

With 100% success and a p99 of 20 ms, this test can no longer measure the system —
there is no observable bottleneck, and peak throughput is the Gatling ramp, not
the capacity of the API.

What remains is the **compliance approach**: 1.5 CPU and 3.0 GB split across the
four containers, as the Rinha rules require. With 1.5 CPU instead of the machine's
12, a bottleneck should reappear — and it will be the first of the series to be a
CPU bottleneck, not I/O and not configuration.

---

## Approach 7 — compliance: 1.5 CPU and 3.0 GB

```
nginx      0.20 CPU / 0.3 GB
  ├── api1 0.30 CPU / 0.6 GB ── pool of 10 ─┐
  └── api2 0.30 CPU / 0.6 GB ── pool of 10 ─┴── database 0.70 CPU / 1.5 GB
```

Keeps everything from approach 6 and applies the restrictions the Rinha rules
require: **1.5 CPU units and 3.0 GB in total**, split across the four containers.
It is the first configuration in the series that would be valid in the tournament.

Until now every approach ran with no limits at all, competing for the machine's 12
CPUs with the load generator itself. Now the application gets **12.5% of what it
had before**.

### How the budget was divided

The split was not arbitrary — it came from the CPU cost already measured with
`EXPLAIN ANALYZE` on each endpoint:

| Endpoint | Requests | Unit cost | Total CPU in the run | Share |
|---|---|---|---|---|
| criação | 54,640 | 0.82 ms | 44.8 s | **83%** |
| consulta | 46,580 | 0.15 ms | 7.0 s | 13% |
| busca válida | 9,590 | 0.20 ms | 1.9 s | 4% |
| busca inválida | 4,190 | — | 0 s | 0% |
| **Total** | | | **53.7 s** | |

Over the 207 seconds of the run that comes to 0.26 CPU on average. But the peak
was 1,267 req/s against a mean of 556 — a factor of 2.3× — so **Postgres needs
~0.59 CPU at the moment of highest load**.

Hence the allocation:

| Container | CPU | Memory | Rationale |
|---|---|---|---|
| database | **0.70** | 1.5 GB | 0.59 measured at the peak + 19% of headroom; 83% of it is GIN index maintenance on `INSERT` |
| api1 | 0.30 | 0.6 GB | ~630 req/s per replica: Express, JSON and the `pg` protocol |
| api2 | 0.30 | 0.6 GB | same |
| nginx | 0.20 | 0.3 GB | proxying 1,267 req/s is cheap work for 1 worker |
| **Total** | **1.50** | **3.0 GB** | |

**The memory is pure headroom.** At rest the four containers add up to 135 MB —
nginx 2.5 MB, each API 25 MB, Postgres 85 MB. The 3.0 GB of the budget are
irrelevant for this workload; the contention is entirely for CPU. The memory split
exists only to satisfy the rule and to avoid an OOM on some spike.

### Configuration

| | |
|---|---|
| Database strategy | `pg.Pool` — up to 10 connections per process |
| API replicas | 2 |
| Load balancer | nginx, round-robin upstream |
| **CPU/memory limits** | **1.5 CPU / 3.0 GB — as the rules require** |
| Indexes | primary key, `UNIQUE` on `apelido` and GIN `gin_trgm_ops` over `busca` |

### Statistics

| Metric | Value | vs. approach 6 |
|---|---|---|
| **Requests** | 92,032 | −20.0% |
| **Success** | 55,886 — **60.72%** | **−39.3 p.p.** |
| Failures | **36,146** | 0 |
| **People created** | **23,611** | **−49.3%** |
| Lost writes | 0 | = |
| **p50** | **1 ms** | = |
| p75 | 4 ms | 4× |
| p95 | 1,595 ms | 266× |
| **p99** | **2,429 ms** | **121×** |
| max | 5,309 ms | 45× |
| mean | 224 ms | 112× |
| Peak throughput at 100% success | 902 req/s ² | 1,267 req/s |
| Mean useful throughput | 266 req/s | −52% |
| **Seconds with failures** | **85 of 210** | 0 |
| **Breaking point** | **t=119s — 395 users/s** | none |
| Degradation starts | t=119s | none |
| Peak concurrency | 259 (518 of 512 slots) | 29 (58 slots) |
| Throughput in the last 60s | 262 req/s (−81% from the peak) | 1,034 req/s |

² See the caveat about the drainage spikes in the diagnosis — this number does not
measure capacity in this approach.

### Per endpoint

| Endpoint | Requests | OK | KO | p50 | p99 |
|---|---|---|---|---|---|
| criação | 54,641 | 27,609 | 27,032 | 1 ms | 2,389 ms |
| consulta | 23,611 | 21,036 | 2,575 | 1 ms | 2,288 ms |
| busca válida | 9,590 | 4,983 | 4,607 | 2 ms | 3,091 ms |
| busca inválida | 4,190 | 2,258 | 1,932 | 1 ms | 7 ms |

### Diagnosis

**The restriction dropped the system back to the level of approach 1** — 60.72%
against 59.60%. Seven rounds of optimization were cancelled out by a CPU limit.

The cgroup's `cpu.stat` answers exactly where:

| Container | Granted | Used (mean) | Usage | Periods with throttling | Time frozen |
|---|---|---|---|---|---|
| **database** | 0.70 | 0.41 | 59% | **41.9%** | **808.7 s** |
| api1 | 0.30 | 0.05 | 15% | 0.2% | 0.4 s |
| api2 | 0.30 | 0.05 | 16% | 0.3% | 0.7 s |
| nginx | 0.20 | 0.04 | 20% | 0.2% | 0.1 s |
| **Total** | **1.50** | **0.54** | **36%** | | |

**Postgres was frozen in 42% of all 100 ms windows, adding up to 808 seconds of
forced pause in a 210-second run** (the number exceeds the duration because it
counts parallel processes). The other three containers barely suffered any
throttling.

### The system failed while using 36% of the budget

This is the most important figure of the round. **The set consumed 0.54 of the
1.5 CPU granted and still rejected 39% of the requests.** Budget was not
missing — distributing it where the work was is what was missing.

While the database was frozen almost half the time, the two APIs ran at 15% of
their own quota. The Rinha rule was not the problem; my split was.

### Where the estimate went wrong: `Planning Time`

I computed the budget from the `Execution Time` of `EXPLAIN ANALYZE`. That field
measures only the execution of the plan — **it does not include the time to plan
the query**, which Postgres pays on every call.

| Query | Planning | Execution | Total | What I used |
|---|---|---|---|---|
| busca | **1.154 ms** | 0.193 ms | 1.347 ms | 0.20 ms |
| consulta | **0.470 ms** | 0.057 ms | 0.527 ms | 0.15 ms |
| criação | 0.063 ms | 0.795 ms | 0.858 ms | 0.82 ms |

On the search, planning costs **6× more than executing**. It is a direct
consequence of the index: with three possible paths (GIN, `Seq Scan`, primary key)
the planner has more to evaluate, and the query itself became so cheap that
planning came to dominate.

Redoing the math with both fields:

```
my estimate  : 46.6 s of CPU  →  0.59 CPU at the peak  →  fits in 0.70  ✅
real cost    : 72.2 s of CPU  →  0.78 CPU at the peak  →  DOES NOT fit  ❌
```

I underestimated by 1.5×. The database needed more than it got precisely at the
peak.

### Low mean, high throttling — the tail again

The database used 59% of its quota **on average** and was still frozen in 42% of
the windows. That is not a contradiction: Docker's throttling judges each 100 ms
window in isolation. Irregular demand blows past the quota in some windows and
sits idle in others, and the mean hides both.

It is the same lesson as
[approach 6](#the-prediction-was-wrong-on-the-part-that-mattered), now on the
infrastructure side: **means do not predict tail behavior**. A mean-CPU chart
would have shown 59% and given the impression of comfortable headroom.

### The signature of throttling in the throughput

The breaking point came at t=119s with only 395 users/s — earlier than in any
previous approach, including the first. After that the behavior becomes a sawtooth
in a characteristic way:

| t | ok/s | ko/s | p50 |
|---|---|---|---|
| 193 | 129 | 634 | 1,690 ms |
| 194 | 190 | 612 | 1,403 ms |
| **195** | **1,356** | **124** | **2 ms** |
| **196** | **583** | **121** | **1 ms** |
| 197 | 177 | 625 | 789 ms |

Seconds 195 and 196 are not recovery — they are **drainage**. The queue built up
during the freeze flushes all at once when the database gets CPU again, with very
low latency because the queries themselves are still cheap. Then the queue starts
over.

That is why this round's "peak throughput at 100% success", 902 req/s, does not
measure capacity: it is the size of a drainage burst, not a sustainable
throughput.

### The bottleneck moved again

The 35,357 `worker_connections` warnings and the 259 simultaneous requests (518 of
the 512 slots) reproduce exactly the pattern of approaches 1 to 3. But the cause is
different: before it was the `Seq Scan`, now it is throttling. The chain is the
same —

```
frozen CPU → high latency → L = λ × W inflates concurrency
           → 512 slots exhausted → nginx closes the socket
```

Postgres logged no connection errors: the pool stayed healthy. The problem was not
access to the database, it was the database not having CPU to serve.

The reconciliation closes exactly:

```
Gatling KO       : 36,146 = 36,002 Premature close + 144 status 500
status 500       :    144 = worker_connections when connecting upstream
status 201       : 23,611 = rows in Postgres = `consulta` requests
status 400       :  2,457 = 2,258 from `busca inválida` + 199 from `criação`
errors in Postgres:     0 connection errors
```

### Next step

The fix is to redistribute the budget following the measured consumption, without
touching the 1.5 CPU total:

| Container | Current | Used | **Proposal** | Headroom over the peak |
|---|---|---|---|---|
| database | 0.70 | 0.41 | **1.00** | 28% over the 0.78 of the peak |
| api1 | 0.30 | 0.05 | **0.20** | 4× |
| api2 | 0.30 | 0.05 | **0.20** | 4× |
| nginx | 0.20 | 0.04 | **0.10** | 2.5× |
| **Total** | **1.50** | 0.54 | **1.50** | |

And there is an application-level optimization this round revealed: **`Planning
Time` dominates two of the three queries**. A `PREPARE` (or the `pg` prepared
statements, via the `name` option on the query) plans once and reuses, which would
attack 1.15 ms of the search's 1.35 ms. It is the first bottleneck of the series
that lives in Postgres but is neither I/O nor index.

---

## Approach 8 — compliance with a redistributed budget

```
nginx      0.10 CPU / 0.3 GB
  ├── api1 0.20 CPU / 0.6 GB ── pool of 10 ─┐
  └── api2 0.20 CPU / 0.6 GB ── pool of 10 ─┴── database 1.00 CPU / 1.5 GB
```

The same 1.5 CPU and 3.0 GB total as approach 7, redistributed according to what
`cpu.stat` measured. Nothing changed in the code, the index or the topology — **the
only variable is where the budget goes**.

| Container | Approach 7 | Used there | **Approach 8** | Headroom over peak demand |
|---|---|---|---|---|
| database | 0.70 | 0.41 (throttled 42%) | **1.00** | 28% over the 0.78 of the peak |
| api1 | 0.30 | 0.05 | **0.20** | 4× |
| api2 | 0.30 | 0.05 | **0.20** | 4× |
| nginx | 0.20 | 0.04 | **0.10** | 2.5× |
| **Total** | 1.50 | 0.54 | **1.50** | |

Approach 7 failed while consuming 36% of the budget: the database was frozen in
42% of the 100 ms windows while the APIs ran at 15% of their own quota. This round
tests whether the problem really was distribution and not scarcity.

### Configuration

| | |
|---|---|
| Database strategy | `pg.Pool` — up to 10 connections per process |
| API replicas | 2 |
| Load balancer | nginx, round-robin upstream |
| **CPU/memory limits** | **1.5 CPU / 3.0 GB — as the rules require** |
| Indexes | primary key, `UNIQUE` on `apelido` and GIN `gin_trgm_ops` over `busca` |

### Statistics

| Metric | Value | vs. approach 7 |
|---|---|---|
| **Requests** | 99,010 | +7.6% |
| **Success** | 73,802 — **74.54%** | **+13.8 p.p.** |
| Failures | 25,208 | −30.3% |
| **People created** | **30,603** | **+29.6%** |
| Lost writes | 0 | = |
| **p50** | **1 ms** | = |
| p75 | 52 ms | 13× |
| p95 | 1,090 ms | −32% |
| **p99** | **1,590 ms** | **−35%** |
| max | 3,114 ms | −41% |
| mean | 167 ms | −25% |
| Peak throughput at 100% success | 1,600 req/s ² | 902 req/s |
| Mean useful throughput | 355 req/s | +33% |
| **Seconds with failures** | 68 of 208 | 85 of 210 |
| **Sustained breaking point** | **t=145s — 499 users/s** | t=119s — 395 u/s |
| First isolated failure | t=126s | t=119s |
| Degradation starts | t=132s | t=119s |
| Peak concurrency | 420 | 259 |
| Throughput in the last 60s | 431 req/s | 262 req/s |

### Per endpoint

| Endpoint | Requests | OK | KO | p50 | p99 |
|---|---|---|---|---|---|
| criação | 54,627 | 35,813 | 18,814 | 1 ms | 1,504 ms |
| consulta | 30,603 | 28,749 | 1,854 | 1 ms | 1,473 ms |
| busca válida | 9,590 | 6,378 | 3,212 | 6 ms | 1,898 ms |
| busca inválida | 4,190 | 2,862 | 1,328 | 1 ms | 273 ms |

### Diagnosis

**Redistributing worked — but half as much as predicted.** The diagnosis was right
about the direction and wrong about the magnitude:

| | Approach 7 | **Approach 8** |
|---|---|---|
| Success | 60.72% | **74.54%** |
| People created | 23,611 | **30,603** |
| Sustained breaking point | t=119s | **t=145s** |
| Database throttling | 41.9% | **33.9%** |
| Database CPU (mean) | 0.41 of 0.70 | **0.51 of 1.00** |

Thirty percent more CPU on the database bought 26 seconds of survival and 7
thousand more people. But **the "throttling close to zero" prediction was badly
wrong: it went from 42% to 34%.**

### Why 1.00 CPU was not enough, even at 51% mean usage

The database consumed 107 s of CPU out of 211 s — **51% of the quota** — and was
still frozen in a third of the windows. The same paradox as approach 7, now with a
more concrete explanation.

A quota of 1.00 CPU means **100 ms of CPU in every 100 ms window**. But Postgres is
multi-process: with 2 replicas × 10 pool connections, up to **20 backends** may be
runnable in the same window. If five of them each want 30 ms, the instantaneous
demand is 150 ms in a 100 ms window — the quota runs out before the window ends and
they all freeze together.

```
quota  : 100 ms of CPU per 100 ms window
demand : N backends x the time of each query, simultaneously
```

**The mean does not see this.** In half the windows the database sits nearly idle,
in the other half it wants more than an entire CPU. It is the third time in the
series that a measure of central tendency hides the behavior that matters.

### The nginx cut charged its price

| | Approach 7 (0.20) | Approach 8 (0.10) |
|---|---|---|
| nginx throttling | 0.2% | **5.4%** |
| Time frozen | 0.1 s | 6.6 s |

Halving nginx made its throttling rise 27×. It is still small next to the
database's 34%, but it explains a visible side effect: peak concurrency went from
259 to **420**. With less CPU, nginx takes longer even to refuse connections, so
they pile up instead of being discarded quickly.

It also shows up in `busca inválida`, which never touches the database and still
had a p99 of **273 ms** — against 7 ms in approach 7. That endpoint can only be
affected by throttling of nginx or of Node.

### The system still fails while using 45% of the budget

| Container | Granted | Used | Usage | Throttling |
|---|---|---|---|---|
| database | 1.00 | 0.51 | 51% | **33.9%** |
| api1 | 0.20 | 0.06 | 30% | 1.9% |
| api2 | 0.20 | 0.06 | 30% | 1.6% |
| nginx | 0.10 | 0.05 | 45% | 5.4% |
| **Total** | **1.50** | **0.67** | **45%** | |

It improved from 36% to 45%, but the pattern persists: **no container comes close
to saturating its mean, and a quarter of the requests still fail**. Continuing to
move CPU between containers has diminishing returns — the APIs are already at 30%
of their quota, there is not much left to take from them.

The way forward stopped being to distribute better. It became **to do less work**.

### The target: 27% of the database CPU is query planning

Summing the `Planning Time` of each endpoint by this run's volume:

| Query | Calls | Unit planning | CPU on planning alone |
|---|---|---|---|
| consulta | 30,603 | 0.470 ms | **14.4 s** |
| busca válida | 9,590 | 1.154 ms | **11.1 s** |
| criação | 54,627 | 0.063 ms | 3.4 s |
| **Total** | | | **28.9 s of 107 s = 27%** |

**More than a quarter of the database CPU is spent deciding how to execute queries
that never change.** All three are fixed, with the same positional parameters on
every call — the plan could be computed once and reused.

The reconciliation closes exactly:

```
Gatling KO       : 25,208 = 25,041 Premature close + 167 status 500
status 500       :    167 = worker_connections when connecting upstream
status 201       : 30,603 = rows in Postgres = `consulta` requests
status 400       :  3,112 = 2,862 from `busca inválida` + 250 from `criação`
errors in Postgres:     0 connection errors
```

### Next step

**Prepared statements.** The `pg` driver supports them via the `name` option on
the query: Postgres plans on the first call and reuses the plan on the following
ones. It attacks the 28.9 s — about 27% of the database CPU — directly, at no cost
in memory or concurrency.

A secondary adjustment to consider alongside it: **the pool of 10 per process may
be too large for 1.00 CPU**. Twenty backends competing for the equivalent of one
CPU produce exactly the burst that blows past the 100 ms window. A smaller pool
would queue more in the application, but with smaller bursts at the database.
Worth measuring separately from the prepared statement, one variable at a time.

---

## Method

```
npm run bench     # reset the environment + full test
npm run report    # open the report of the last run
npm run stats     # CPU/memory per container, live (second terminal)
```

The test is the official Gatling one, copied into `stress-test/`: three scenarios
in parallel for 3min25s, with a ramp up to 740 combined users/s.

### Rules that make the measurements comparable

**The database must be wiped between runs.** Five early rounds of this project
swung between 99.8% and 32.5% success **with no code change at all** — the
Postgres volume survived `docker compose down` and each round piled up ~50
thousand people in the table. That is why `infra:down` always uses `-v`, and why
`bench` checks that the initial count is `0`.

**The JDK must be 17.** Gatling 3.9.5 compiles the simulation in Scala 2.13.10,
which cannot read class files from modern JDKs and fails with
`bad constant pool index: 0`. `run-test.sh` pins `JAVA_HOME` internally.

### Environment

| | |
|---|---|
| Machine | Apple Silicon, 12 CPUs, 24 GB |
| Docker VM | 12 CPUs, 7.75 GB |
| Load generator | Gatling 3.9.5 on Temurin 17, on the same machine |
| Postgres | 16.0-alpine |
| Node | 24.15.0-alpine |

The load generator shares CPU with the application, so the absolute numbers are not
comparable with the official ranking (run on EC2). What counts is the **comparison
between approaches under identical conditions**.

### How to read the numbers

Gatling injects in an **open model**: it creates users at a fixed rate by the
clock, without looking at the health of the server. If the API saturates, the load
does not back off — which is why throughput collapses instead of settling on a
plateau.

- **Injection rate** is the load *offered*, not the load accepted. Do not confuse
  it with requests/s (each user of scenario A makes up to 2) nor with simultaneous
  users (`L = λ × W`).
- The **"Active Users"** chart counts every user that existed at *any moment*
  within the second; the metrics here use the instantaneous snapshot, which is
  what competes for resources. In approach 1: `996 = 263 simultaneous + 734
  created during the second`.
- The injection rate appears in no chart at all: it comes from the simulation code.
  The instant of the break is visible in **"Number of responses per second"**,
  where the red KO band begins.
