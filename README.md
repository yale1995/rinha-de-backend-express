# Rinha de Backend 2023/Q3 in Express + Postgres + nginx

A people-registration API driven through eight rounds of a 740 users-per-second stress test. Unrestricted, it went from 40% of requests failing to 100% succeeding. Under the competition's real 1.5 CPU / 3 GB limits, the failure rate came back and the latest round sits at 74.5% success. The code is small; the value is in the method: one variable changed at a time, each with a prediction written down before the run and an exact reconciliation of the numbers afterward.

## The problem

The [Rinha de Backend](https://github.com/zanfranceschi/rinha-de-backend-2023-q3) is a Brazilian backend competition. The task sounds simple: an API with four CRUD endpoints over a Postgres database.

| Endpoint                | What it does                                      |
| ----------------------- | ------------------------------------------------- |
| `POST /pessoas`         | creates a person                                  |
| `GET /pessoas/:id`      | fetches a person                                  |
| `GET /pessoas?t=term`   | searches by term across nickname, name, and stack |
| `GET /contagem-pessoas` | returns the total count                           |

The evaluation is the opposite of simple. A Gatling stress test ramps up to 740 users per second over three and a half minutes, with 1.5 CPU and 3 GB of memory to split across all containers. Whoever sustains the most successful requests without losing writes wins.

## Architecture

| Layer         | Technology                                |
| ------------- | ----------------------------------------- |
| API           | Node.js + Express 5                       |
| Driver        | node-postgres (`pg`)                      |
| Database      | PostgreSQL 16                             |
| Load balancer | nginx (round-robin)                       |
| Orchestration | Docker Compose with CPU and memory limits |
| Test          | Gatling 3.9.5, the official Rinha test    |

```
Gatling
   |
   v
nginx (round-robin, :9999)
   |
   +---> api1 ---+
   |             +---> Postgres 16
   +---> api2 ---+
```

## What's different here

Most Rinha submissions ship an API that "passes". This repository ships the investigation of **why** each configuration behaves the way it does.

The eight runs follow three rules that make the numbers comparable:

1. **One variable at a time.** Each approach changes exactly one thing from the previous one: the index, the replica count, the connection strategy, the CPU split. Never two at once.
2. **A prediction written down before the run.** Each approach states what it expects to measure and why. Then the data confirms or corrects it. In three of the eight, it corrected.
3. **Exact reconciliation.** No number is left floating. `201 = rows in Postgres = query requests`. The nginx log, the Postgres log, and the Gatling log must close the same account, with nothing left over.

That's what separates this repository from a sample CRUD: every conclusion comes with the evidence behind it.

## The journey in one table

| # | Approach                           | Success     | People created | p99       | Bottleneck               |
| - | ---------------------------------- | ----------- | -------------- | --------- | ------------------------ |
| 1 | `pg.Client`, 1 replica             | 59.60%      | 25,166         | 1,486 ms  | `Seq Scan` with no index |
| 2 | `pg.Client`, 2 replicas            | 74.49%      | 32,111         | 1,576 ms  | `Seq Scan` with no index |
| 3 | `pg.Client`, 1 replica, GIN index  | 93.62%      | 42,851         | 733 ms    | single connection        |
| 4 | `pg.Client`, 2 replicas, GIN index | 99.96%      | 46,549         | 212 ms    | single-connection spikes |
| 5 | connection per request             | 99.51%      | 45,660         | 203 ms    | `max_connections`        |
| 6 | `pg.Pool`, 2 replicas, GIN index   | **100.00%** | **46,580**     | **20 ms** | none                     |
| 7 | same as 6, with 1.5 CPU / 3 GB     | 60.72%      | 23,611         | 2,429 ms  | Postgres CPU             |
| 8 | same as 7, budget redistributed    | 74.54%      | 30,603         | 1,590 ms  | Postgres CPU             |

Full per-endpoint numbers for each run are in [BENCHMARKS.md](BENCHMARKS.md).

## What the investigation showed

Each step became a lesson with a name:

- **Parallelizing is not the same as making it cheaper.** Doubling replicas gained +22%, not 2x, because the `Seq Scan` got more expensive as the table grew. The bottleneck did not scale horizontally.
- **Removing work beats parallelizing it.** The trigram index (`pg_trgm` + GIN) took search from ~57 ms to 0.21 ms and changed the shape of the curve, not just its position.
- **The median hides the tail.** Median concurrency said "no queue", but 5% of the time the queue reached 90 requests. That's where all the failures lived. The pool eliminated the worst case, not the common case.
- **Telemetry can lie.** The connection-per-request approach silently lost 71 writes: the endpoint's `catch` returned `422` for any error, so an infrastructure failure became a "validation error". Only cross-referencing the logs revealed it.
- **The bottleneck moves.** The same change has opposite signs depending on where the bottleneck is. Connection-per-request would have helped in approach 1 and hurt in approach 5.

The compliance runs (7 and 8) added a second lesson: with a 1.5 CPU ceiling, the system failed while using only 36% and 45% of its budget, because of cgroup throttling combined with query planning time. At that point the goal stopped being "distribute better" and became "do less work". The next step, prepared statements, targets the ~27% of Postgres CPU currently spent planning identical queries.

## Skills this repository exercises

For anyone evaluating the work, this is where the skills show up:

- **Performance engineering**: reading percentiles, tail latency, Little's Law (`L = λ × W`), identifying the bottleneck by evidence, not intuition.
- **PostgreSQL**: trigram index with GIN, generated columns, planner behavior (`EXPLAIN ANALYZE`), `Planning Time`, connection pooling, and prepared statements.
- **Infrastructure**: nginx as a load balancer, Docker Compose with resource limits, CPU budgeting, and reading `cpu.stat` to diagnose throttling.
- **Applied scientific method**: hypothesis, written-down prediction, measurement under identical conditions, and exact reconciliation. Getting the prediction wrong is part of the result, as long as the data shows why.

## How to run

Prerequisites: Docker and Node.js for the scripts. For the stress test, Gatling 3.9.5 with JDK 17.

```bash
# 1. Bring up the stack (Postgres + 2 APIs + nginx)
npm run infra:up

# 2. The API responds at http://localhost:9999
curl http://localhost:9999/contagem-pessoas

# 3. Run the full benchmark (resets the database and fires Gatling)
npm run bench
```

Open the Gatling report with `npm run report`.

## Documentation

- [BENCHMARKS.md](BENCHMARKS.md): the eight approaches, one by one, with prediction, statistics, and diagnosis (in Portuguese).
- [STRESS_TEST.md](STRESS_TEST.md): how the official test works, scenario by scenario (in Portuguese).
- [INTRUÇOES.MD](INTRUÇOES.MD): the original competition rules (in Portuguese).

## Author

Yale Araújo, full-stack software engineer.

- GitHub: [yale1995](https://github.com/yale1995)
- LinkedIn: [in/yalearaujo](https://www.linkedin.com/in/yalearaujo)
