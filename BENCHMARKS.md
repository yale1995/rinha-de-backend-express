# Benchmarks

Medições desta API sob o teste de stress oficial da
[Rinha de Backend 2023/Q3](https://github.com/zanfranceschi/rinha-de-backend-2023-q3).

Cada abordagem muda **uma variável por vez** e é medida sob condições idênticas,
para que os números sejam diretamente comparáveis.

---

## Comparativo

| # | Abordagem | Sucesso | Usuários criados | p50 | p99 | Vazão máx | Ruptura | Gargalo |
|---|---|---|---|---|---|---|---|---|
| [1](#abordagem-1--conexão-única-1-réplica) | `pg.Client`, 1 réplica | 59,60% | 25.166 | 1 ms | 1.486 ms | 610 req/s | 371 u/s | `Seq Scan` sem índice |
| [2](#abordagem-2--conexão-única-2-réplicas) | `pg.Client`, 2 réplicas | 74,49% | 32.111 | 1 ms | 1.576 ms | 745 req/s | 459 u/s | `Seq Scan` sem índice |
| [3](#abordagem-3--conexão-única-1-réplica-índice-gin--pg_trgm) | `pg.Client`, 1 réplica, GIN `pg_trgm` | **93,62%** | **42.851** | 1 ms | **733 ms** | **1.257 req/s** | 467 u/s | conexão única + slots do nginx |
| [4](#abordagem-4--2-réplicas-índice-gin--pg_trgm) | `pg.Client`, 2 réplicas, GIN `pg_trgm` | **99,96%** | **46.549** | 1 ms | **212 ms** | 1.256 req/s ¹ | — | picos da conexão única → slots do nginx |
| [5](#abordagem-5--conexão-por-requisição-tryfinally) | conexão por requisição, 2 réplicas, GIN | 99,51% | 45.660 | 5 ms | 203 ms | 1.263 req/s ¹ | — | `max_connections` do Postgres |
| [6](#abordagem-6--pool-de-conexões-pgpool) | `pg.Pool` (10/processo), 2 réplicas, GIN | **100,00%** | **46.580** | 1 ms | **20 ms** | 1.267 req/s ¹ | — | **nenhum atingido** |
| [7](#abordagem-7--conformidade-15-cpu-e-30-gb) | pool + 2 réplicas + GIN, **1,5 CPU / 3,0 GB** | 60,72% | 23.611 | 1 ms | 2.429 ms | 902 req/s ² | 395 u/s | CPU do Postgres (throttling) |
| [8](#abordagem-8--conformidade-com-orçamento-redistribuído) | idem, orçamento redistribuído (db 1,00) | 74,54% | 30.603 | 1 ms | 1.590 ms | 1.600 req/s ² | 499 u/s | CPU do Postgres (throttling) |


¹ A partir da abordagem 3 a vazão máxima passa a ser limitada pela rampa do
Gatling, que satura em 740 usuários/s. O número deixa de medir a capacidade do
sistema — ver [diagnóstico da abordagem 4](#a-pergunta-dos-2-não-pôde-ser-respondida).

---

## Abordagem 1 — conexão única, 1 réplica

```
nginx (1 worker, 512 slots)
  └── api1 ── 1 processo Node ── 1 conexão ── Postgres
```

Ponto de partida ingênuo: um único processo Node abre **uma** conexão com o
Postgres no boot e a reutiliza para todas as requisições. Sem pool, sem réplicas,
sem índices além dos criados pelo schema. Serve de linha de base para tudo o que
vier depois.

### Configuração

| | |
|---|---|
| Estratégia de banco | `pg.Client` — uma conexão aberta no boot |
| Réplicas da API | 1 |
| Load balancer | nginx, configuração padrão |
| Limites de CPU/memória | nenhum |
| Índices | apenas PK e `UNIQUE` de `apelido` |
| Execuções | 2 independentes, métricas dentro de 1% entre si |

### Estatísticas

| Métrica | Valor |
|---|---|
| **Requisições** | 93.581 |
| **Sucesso** | 55.775 — **59,60%** |
| Falhas | 37.806 |
| **Usuários criados** | **25.166** |
| Escritas perdidas | 0 |
| **p50** | **1 ms** |
| p75 | 538 ms |
| p95 | 1.264 ms |
| **p99** | **1.486 ms** |
| máx | 1.677 ms |
| média | 257 ms |
| **Vazão máxima com 100% de sucesso** | **610 req/s** |
| Vazão com p50 ≤ 20 ms | 577 req/s |
| Vazão útil média | 272 req/s |
| **Ponto de ruptura** | **t=113s — 371 usuários/s injetados** |
| Início da degradação | t=107s |
| Concorrência no pico | 272 simultâneos |
| Vazão nos últimos 60s | 237 req/s (−61% desde o pico) |

### Por endpoint

| Endpoint | Requisições | OK | KO | p50 | p99 | Custo no Postgres |
|---|---|---|---|---|---|---|
| criação | 54.635 | 29.473 | 25.162 | 1 ms | 1.497 ms | 0,25 ms (Insert) |
| consulta | 25.166 | 18.707 | 6.459 | 2 ms | 1.442 ms | 0,14 ms (Index Scan) |
| busca válida | 9.590 | 5.262 | 4.328 | 7 ms | 1.518 ms | **57,57 ms (Seq Scan)** |
| busca inválida | 4.190 | 2.333 | 1.857 | 1 ms | 5 ms | não toca o banco |

### Diagnóstico

**Gargalo: o `Seq Scan` da busca.** O `ILIKE '%termo%'` com curinga à esquerda
não usa índice B-tree e varre a tabela inteira — 57,57 ms com 25 mil linhas,
cerca de 400× o custo das outras queries. Como a conexão é única e serializa
tudo, esse custo domina, e **piora durante a corrida**: cada criação bem-sucedida
encarece as buscas seguintes.

| Momento | linhas | custo do scan | fatia do tempo da conexão | capacidade |
|---|---|---|---|---|
| t=50s | 1.207 | 2,8 ms | 44% | ~1.430 q/s |
| t=110s | 10.932 | 25,0 ms | **85%** | ~370 q/s |
| t=200s | 24.503 | 56,1 ms | **93%** | ~180 q/s |

A busca é 8,9% das queries e consome 85% da conexão no momento da quebra. A carga
sobe enquanto a capacidade cai; a ruptura é onde as curvas se cruzam.

**Mas as falhas aconteceram no nginx.** A latência do banco inflou a concorrência
(`L = λ × W`) até esgotar os 512 slots do worker padrão — como proxy, cada
requisição ocupa dois slots, logo o teto real é 256 simultâneas. A concorrência
cruzou esse limite em t=113s, exatamente o segundo da primeira falha, e travou em
262–265 pelos 90 s restantes mesmo com a injeção dobrando.

```
Seq Scan caro → latência alta → concorrência infla
              → 512 slots esgotam → nginx fecha o socket
```

O nginx é **onde** o sistema quebrou; o índice ausente é **por que**.

Três evidências sustentam isso:

- **Os 37.806 KOs não têm uma linha de access log** e trazem uma única mensagem
  no cliente, `Premature close`. Não há `502`, `504` nem `503` — as conexões
  morreram antes de o nginx alocar um slot. O `busca inválida`, que responde
  `400` sem tocar no banco, teve p99 de 5 ms e ainda assim 44% de falhas.
- **Com latência saudável o limite nunca seria atingido.** Em t=106s, `W = 23 ms`
  e a concorrência era 8. Projetando esse W para o pico de 722 u/s: 17 usuários,
  34 slots — 15× de folga.
- **Os três endpoints que tocam o banco convergiram em ~270 ms de média**, apesar
  de custos reais de 0,14 / 0,25 / 57,57 ms. A latência não vem do trabalho, vem
  da fila: o `_queryQueue` do `pg.Client` despacha uma query por vez. O `criação`
  tem p50 de 1 ms e p75 de 561 ms — um penhasco, não uma curva: duas populações,
  fila vazia e fila cheia, nada no meio.

### Próximo passo

Três correções atacam coisas diferentes e devem ser medidas separadamente:

- **Réplicas da API** (abordagem 2) — mais processos, mais conexões, mas o custo
  de cada scan continua o mesmo.
- **Pool de conexões** — não torna o scan mais barato, permite que ele aconteça
  em paralelo. Resolve o head-of-line blocking.
- **Índice `pg_trgm` + GIN** — elimina o trabalho em vez de paralelizá-lo. Ataca
  a causa raiz.

---

## Abordagem 2 — conexão única, 2 réplicas

```
nginx (1 worker, 512 slots, round-robin)
  ├── api1 ── 1 processo Node ── 1 conexão ─┐
  └── api2 ── 1 processo Node ── 1 conexão ─┴── Postgres
```

Mesmo código da abordagem 1: cada processo continua com **uma** conexão
`pg.Client`. A única variável alterada é o número de réplicas — o nginx passa a
distribuir a carga entre `api1` e `api2` em round-robin. Duas filas independentes
de profundidade 1 em vez de uma.

### Configuração

| | |
|---|---|
| Estratégia de banco | `pg.Client` — uma conexão por processo |
| Réplicas da API | 2 |
| Load balancer | nginx, upstream round-robin |
| Limites de CPU/memória | nenhum |
| Índices | apenas PK e `UNIQUE` de `apelido` |

### Previsão registrada antes da corrida

Custo da busca medido com `EXPLAIN ANALYZE` sobre as 32.111 linhas deixadas pela
abordagem 2, antes e depois do índice:

| Termo | `Seq Scan` | GIN trigram | Ganho |
|---|---|---|---|
| inexistente | 63,08 ms | **0,12 ms** | **525×** |
| `Node` | 55,05 ms | **0,16 ms** | 344× |
| `ana` | 27,39 ms | **0,30 ms** | 92× |

Previsões: a ruptura deve sumir ou ir para muito perto do fim; se persistir, o
gargalo mudou de lugar. Apenas ~4% das buscas (termos de 1–2 caracteres, que não
geram trigrama) devem cair em `Seq Scan`. E o índice GIN deve encarecer o
`INSERT` — se a vazão de escrita cair, o custo apareceu.

**Resultado: duas certas, uma errada.** A ruptura sustentada sumiu e a escrita
encareceu 3,2×, como previsto. Os 4% de `Seq Scan` viraram 55% — ver abaixo.

### Estatísticas

| Métrica | Valor | vs. abordagem 1 |
|---|---|---|
| **Requisições** | 100.518 | +7,4% |
| **Sucesso** | 74.875 — **74,49%** | +14,9 p.p. |
| Falhas | 25.643 | −32,2% |
| **Usuários criados** | **32.111** | **+27,6%** |
| Escritas perdidas | 0 | = |
| **p50** | **1 ms** | = |
| p75 | 100 ms | −81% |
| p95 | 1.240 ms | −2% |
| **p99** | **1.576 ms** | +6% |
| máx | 1.976 ms | +18% |
| média | 184 ms | −28% |
| **Vazão máxima com 100% de sucesso** | **745 req/s** | **+22%** |
| Vazão com p50 ≤ 20 ms | 700 req/s | +21% |
| Vazão útil média | 360 req/s | +32% |
| **Ponto de ruptura** | **t=135s — 459 usuários/s injetados** | **+22 s / +24%** |
| Início da degradação | t=125s | +18 s |
| Concorrência no pico | 254 simultâneos | −7% |
| Vazão nos últimos 60s | 400 req/s (−46% desde o pico) | +69% |

### Por endpoint

| Endpoint | Requisições | OK | KO | p50 | p99 | Custo no Postgres |
|---|---|---|---|---|---|---|
| criação | 54.627 | 37.614 | 17.013 | 1 ms | 1.583 ms | 0,24 ms (Insert) |
| consulta | 32.111 | 27.649 | 4.462 | 4 ms | 1.569 ms | 0,15 ms (Index Scan) |
| busca válida | 9.590 | 6.676 | 2.914 | 15 ms | 1.625 ms | **65,10 ms (Seq Scan)** |
| busca inválida | 4.190 | 2.936 | 1.254 | 1 ms | 5 ms | não toca o banco |

Custos medidos com `EXPLAIN ANALYZE` ao fim da corrida, com a tabela em 32.111
linhas.

### Diagnóstico

**A previsão de ~2× estava errada. O ganho medido foi de ~22%.** Vale entender
por quê, porque o erro é instrutivo.

Duplicar as réplicas duplicou o paralelismo — duas filas de profundidade 1 em vez
de uma. Mas **o scan não ficou mais barato, e a corrida durou mais**: os 22
segundos extras de sobrevivência foram gastos inserindo linhas na tabela que o
scan varre.

| | ruptura | linhas na tabela | custo do scan | conexões | capacidade relativa |
|---|---|---|---|---|---|
| Abordagem 1 | t=113s | 11.401 | ~23 ms | 1 | 1,00× |
| Abordagem 2 | t=135s | 17.532 | ~36 ms | 2 | **1,28×** |

`2 conexões × (23 ms / 36 ms) = 1,28×` — previsto +28%, medido +22%. O
paralelismo dobrou e o trabalho encareceu 53% no mesmo intervalo, e o que sobrou
foi a diferença.

**Esta é a assinatura de um gargalo que não escala horizontalmente:** cada réplica
adicional aceita mais escritas, cada escrita encarece o `Seq Scan` de todas as
réplicas. O ganho de adicionar réplicas é sublinear e vai encolhendo. O custo por
linha do scan, aliás, não mudou — 65,10 ms / 32.111 linhas = 2,0 µs por linha,
contra 2,3 µs na abordagem 1. Só a tabela cresceu.

**A parede continua sendo a mesma: os 512 slots do nginx.** A concorrência trava
em 254 simultâneas — 508 slots dos 512 disponíveis, já que cada requisição
proxiada ocupa dois. A primeira falha veio em t=135,8s, com ~235 simultâneas.

```
Seq Scan caro → latência alta → concorrência infla
              → 512 slots esgotam → nginx recusa
```

**Novidade: 302 respostas `500`.** Na abordagem 1, 100% das falhas eram invisíveis
— conexões mortas antes de o nginx alocar qualquer slot. Agora uma fração da
exaustão ficou visível: o error log traz **298 ocorrências de
`worker_connections are not enough while connecting to upstream`**, contra 24.163
do mesmo aviso sem o sufixo. Ou seja, o nginx aceitou o cliente e só então
descobriu que não tinha slot para o upstream, devolvendo `500`. Mesmo esgotamento,
dois momentos diferentes.

A reconciliação fecha exata:

```
Gatling KO                        : 25.643
  ├─ Premature close              : 25.341   ← recusadas no accept
  └─ status 500                   :    302   ← recusadas ao conectar no upstream

nginx atendeu                     : 75.177 = 74.875 OK + 302 quinhentos
nunca chegaram ao nginx           : 25.341 = 100.518 − 75.177
linhas no Postgres                : 32.111 = requisições `consulta`
```

Zero escritas perdidas: cada `201` virou linha, cada linha virou uma `consulta`.

**O sinal de fila continua presente, mas mais fraco.** As médias por endpoint
ainda convergem apesar de custos reais 400× diferentes — 184 ms na criação,
199 ms na consulta, 211 ms na busca — mas o p75 da criação caiu de 538 ms para
94 ms. O penhasco entre "fila vazia" e "fila cheia" continua lá; só ficou mais
raso, porque agora há duas filas para cair.

### Próximo passo

A abordagem 2 comprou tempo sem tocar na causa. As duas correções restantes
continuam valendo, e agora com uma previsão mais calibrada:

- **Pool de conexões** — mesma natureza da réplica: paraleliza sem baratear.
  Deve render mais que as réplicas (dezenas de conexões, não duas), mas esbarra
  no mesmo teto móvel: quanto mais escritas passam, mais caro fica cada scan.
  Previsão: ganho sublinear no número de conexões, ruptura empurrada para
  t≈150–170s, parede do nginx ainda presente.
- **Índice `pg_trgm` + GIN** — a única correção que ataca o `Seq Scan` em vez de
  paralelizá-lo. Previsão: é a que deve mudar a forma da curva, não só deslocá-la.

---

## Abordagem 3 — conexão única, 1 réplica, índice GIN + `pg_trgm`

```
nginx (1 worker, 512 slots)
  └── api1 ── 1 processo Node ── 1 conexão ── Postgres (GIN trigram)
```

Volta à topologia da abordagem 1 — uma réplica, uma conexão — para isolar a única
variável que interessa agora: **o índice**. Em vez de paralelizar o `Seq Scan`, o
objetivo é fazê-lo desaparecer.

O `ILIKE '%termo%'` com curinga à esquerda não usa B-tree, mas usa **índice de
trigramas**. Como `ARRAY_TO_STRING` não é `IMMUTABLE`, o Postgres recusa indexar a
expressão diretamente; a solução é materializar os três campos buscáveis em uma
coluna gerada e indexar essa coluna:

```sql
CREATE EXTENSION pg_trgm;

busca TEXT GENERATED ALWAYS AS (busca_texto(apelido, nome, stack)) STORED

CREATE INDEX idx_pessoas_busca ON pessoas USING GIN (busca gin_trgm_ops);
```

A query de busca deixa de ter três `OR` e passa a `WHERE busca ILIKE $1`.

### Configuração

| | |
|---|---|
| Estratégia de banco | `pg.Client` — uma conexão aberta no boot |
| Réplicas da API | 1 |
| Load balancer | nginx, upstream único |
| Limites de CPU/memória | nenhum |
| Índices | PK, `UNIQUE` de `apelido` e **GIN `gin_trgm_ops` sobre `busca`** |

### Estatísticas

| Métrica | Valor | vs. abordagem 1 |
|---|---|---|
| **Requisições** | 111.263 | +18,9% |
| **Sucesso** | 104.160 — **93,62%** | **+34,0 p.p.** |
| Falhas | 7.103 | −81,2% |
| **Usuários criados** | **42.851** | **+70,3%** |
| Escritas perdidas | 0 | = |
| **p50** | **1 ms** | = |
| p75 | 10 ms | −98% |
| p95 | 517 ms | −59% |
| **p99** | **733 ms** | **−51%** |
| máx | 1.014 ms | −40% |
| média | 64 ms | −75% |
| **Vazão máxima com 100% de sucesso** | **1.257 req/s** | **+106%** |
| Vazão com p50 ≤ 20 ms | 1.399 req/s | +142% |
| Vazão útil média | 503 req/s | +85% |
| **Primeira falha** | **t=137s — 467 usuários/s** | +24 s / +26% |
| Ruptura sustentada | **não houve** | — |
| Concorrência no pico | 258 simultâneos | −5% |
| Vazão nos últimos 60s | 866 req/s (−38% desde o pico) | +265% |

### Por endpoint

| Endpoint | Requisições | OK | KO | p50 | p99 | Custo no Postgres |
|---|---|---|---|---|---|---|
| criação | 54.632 | 50.241 | 4.391 | 1 ms | 754 ms | 0,77 ms (Insert + GIN) |
| consulta | 42.851 | 41.245 | 1.606 | 1 ms | 693 ms | 0,15 ms (Index Scan) |
| busca válida | 9.590 | 8.812 | 778 | 6 ms | 765 ms | **0,21 ms (Bitmap Index Scan)** |
| busca inválida | 4.190 | 3.862 | 328 | 1 ms | 6 ms | não toca o banco |

Custos medidos com `EXPLAIN ANALYZE` ao fim da corrida, com a tabela em 42.851
linhas.

### Diagnóstico

**O gargalo foi eliminado, e desta vez a curva mudou de forma — não só de lugar.**

A busca custava 63,08 ms na abordagem 2. Agora custa **0,21 ms**, com uma tabela
33% maior. É o fim do `Seq Scan` como fator dominante.

Mas o número que importa não é esse. É este:

| Terço da corrida | Abordagem 1 | Abordagem 2 | **Abordagem 3** |
|---|---|---|---|
| início (t=0–69s) | 116 req/s | 128 req/s | **110 req/s** |
| meio (t=69–138s) | 448 req/s | 561 req/s | **546 req/s** |
| fim (t=138–207s) | 253 req/s | 391 req/s | **854 req/s** |

Nas duas primeiras abordagens o último terço era **o pior** — a vazão desabava
justamente quando a carga era maior, porque cada linha inserida encarecia todas as
buscas seguintes. Aqui o último terço é o **melhor**. A capacidade parou de decair
durante a corrida.

Isso se confirma no ponto mais improvável: **a vazão máxima com 100% de sucesso,
1.257 req/s, aconteceu em t=205s** — o penúltimo segundo do teste, com a tabela
cheia. Nas abordagens 1 e 2 o pico limpo aconteceu antes da quebra e nunca mais
voltou.

**A falha deixou de ser colapso e virou serrilhado.** Não houve ruptura
sustentada — o script que procura 6 segundos consecutivos de falha não achou
nenhum:

| | Abordagem 1 | Abordagem 2 | **Abordagem 3** |
|---|---|---|---|
| segundos com falha | 95 de 208 | 73 de 208 | **33 de 207 (16%)** |
| maior sequência consecutiva | até o fim | até o fim | **4 segundos** |
| recupera para zero falhas? | não | não | **sim, até 10 s limpos seguidos** |

Nos segundos limpos depois da primeira falha, o sistema entregou **968 req/s em
média**. Ou seja: ele satura por 2–4 segundos, esvazia a fila e volta ao normal. O
p50 nunca ficou acima de 20 ms por 5 segundos seguidos.

### A previsão dos 4% errou por muito

Registrei que apenas 4% das buscas cairiam em `Seq Scan` (termos de 1–2
caracteres, que não geram trigrama). O `pg_stat_user_tables` diz outra coisa:

```
seq_scan  : 4.868      ← 55% das buscas
idx_scan  : 3.950      ← 45% das buscas
```

**O motivo não é limitação do índice, é decisão de custo do planner.** Quando o
termo é comum, o `LIMIT 50` se satisfaz depois de algumas centenas de linhas, e
varrer é mais barato que consultar o índice. O Postgres escolhe o plano por
estimativa de seletividade, não pelo comprimento do termo.

E funciona: mesmo com metade das buscas varrendo, o p99 da busca caiu de 1.518 ms
para 765 ms. O índice não precisou atender todas as buscas — precisou atender as
**caras**, que eram exatamente as de termo raro que varriam a tabela inteira.

### O preço pago

Ambos os custos previstos apareceram, e ambos valeram a pena:

| | Antes | Depois |
|---|---|---|
| custo do `INSERT` | 0,24 ms | **0,77 ms** (3,2×) |
| espaço em disco | — | **19 MB** (10× a PK, que tem 1,8 MB) |

A escrita ficou 3× mais cara e ainda assim as criações bem-sucedidas subiram de
29.473 para **50.241**. O que se ganhou em não bloquear a fila pagou o custo de
manutenção do índice com folga.

### A parede continua sendo o nginx

Os 7.103 KOs têm uma única mensagem, `Premature close`, e o error log traz 6.762
avisos de `worker_connections are not enough` — nenhum deles com o sufixo
`while connecting to upstream`, e zero respostas `500`. A concorrência ainda
encosta em 258 simultâneas (516 slots dos 512).

A diferença é a duração: antes a concorrência travava no teto e ficava lá pelos 90
segundos restantes; agora ela encosta, o sistema drena e ela volta a zero.

A reconciliação fecha exata:

```
Gatling KO        : 7.103 = 111.263 − 104.160, todos Premature close
nginx access log  : 104.160 OK (+12 linhas malformadas)
status 201        : 42.851 = linhas no Postgres = requisições `consulta`
status 400        :  4.183 = 3.862 do `busca inválida` + 321 do `criação`
```

### Próximo passo

Com o `Seq Scan` fora do caminho, sobraram dois candidatos a gargalo, e eles agora
podem ser medidos separadamente:

- **A conexão única** — continua serializando tudo. Um pool deve atacar os picos
  de 2–4 segundos que ainda saturam o nginx.
- **Os 512 slots do nginx** — agora que a latência caiu, é possível que o teto
  seja atingido por vazão legítima, não por fila inflada. É a primeira vez que
  faz sentido mexer na configuração do nginx.

E fica pendente a **abordagem de conformidade**: 2 réplicas e limites de 1,5 CPU /
3,0 GB, que é o que as regras da Rinha exigem e que nenhuma das três abordagens
até aqui respeitou.

---

## Abordagem 4 — 2 réplicas, índice GIN + `pg_trgm`

```
nginx (1 worker, 512 slots, round-robin)
  ├── api1 ── 1 processo Node ── 1 conexão ─┐
  └── api2 ── 1 processo Node ── 1 conexão ─┴── Postgres (GIN trigram)
```

Mantém o índice da abordagem 3 e volta a segunda réplica. Uma variável mudou.

Esta abordagem é o **teste do diagnóstico da abordagem 2**. Lá, duplicar as
réplicas rendeu apenas +22% em vez dos 2× esperados, e a explicação registrada foi
que o `Seq Scan` encarecia enquanto a corrida durava — o paralelismo dobrava, mas
o trabalho crescia junto. Se essa explicação estiver certa, agora que o `Seq Scan`
saiu do caminho **a segunda réplica deve render muito mais do que rendeu antes**.

É também a primeira abordagem que cumpre a exigência da Rinha de duas instâncias
da API. Continua fora das regras nos limites de CPU e memória.

### Configuração

| | |
|---|---|
| Estratégia de banco | `pg.Client` — uma conexão por processo |
| Réplicas da API | 2 |
| Load balancer | nginx, upstream round-robin |
| Limites de CPU/memória | nenhum |
| Índices | PK, `UNIQUE` de `apelido` e GIN `gin_trgm_ops` sobre `busca` |

### Estatísticas

| Métrica | Valor | vs. abordagem 3 |
|---|---|---|
| **Requisições** | 114.963 | +3,3% |
| **Sucesso** | 114.914 — **99,96%** | **+6,3 p.p.** |
| Falhas | **49** | **−99,3%** |
| **Usuários criados** | **46.549** | +8,6% |
| Escritas perdidas | 0 | = |
| **p50** | **1 ms** | = |
| p75 | 2 ms | −80% |
| p95 | 45 ms | −91% |
| **p99** | **212 ms** | **−71%** |
| máx | 377 ms | −63% |
| média | 10 ms | −84% |
| **Vazão máxima com 100% de sucesso** | **1.256 req/s** | = |
| Vazão com p50 ≤ 20 ms | 1.256 req/s | −10% |
| Vazão útil média | 555 req/s | +10% |
| **Segundos com falha** | **1 de 207** | 33 de 207 |
| Ruptura sustentada | não houve | não houve |
| Concorrência mediana (último terço) | **2 simultâneos** | 20 |
| Concorrência no pico | 250 simultâneos | 258 |
| Vazão nos últimos 60s | 1.030 req/s (−18% do pico) | +19% |

### Por endpoint

| Endpoint | Requisições | OK | KO | p50 | p99 | Custo no Postgres |
|---|---|---|---|---|---|---|
| criação | 54.634 | 54.604 | 30 | 1 ms | 217 ms | 0,82 ms (Insert + GIN) |
| consulta | 46.549 | 46.535 | 14 | 1 ms | 207 ms | 0,15 ms (Index Scan) |
| busca válida | 9.590 | 9.586 | 4 | 5 ms | 235 ms | 0,13 ms (Bitmap Index Scan) |
| busca inválida | 4.190 | 4.189 | 1 | 1 ms | 6 ms | não toca o banco |

Custos medidos com `EXPLAIN ANALYZE` ao fim da corrida, com a tabela em 46.549
linhas.

### Diagnóstico

**99,96% de sucesso, com falhas concentradas em um único segundo da corrida.**

As 49 falhas aconteceram todas em t=171s, num pico isolado onde a concorrência
saltou para 239 simultâneas (478 slots). Todas com a mesma mensagem,
`Premature close`, e os avisos de `worker_connections` no nginx caíram de 6.762
para **31**. Nos outros 206 segundos, zero falhas.

O p50 nunca passou de 125 ms em segundo nenhum — contra 759 ms na abordagem 3.

### A previsão acertou, e por margem maior

Previ que a concorrência cairia para a faixa de 130 simultâneas, cerca de metade
do teto do nginx. O resultado foi bem melhor:

| Último terço da corrida (t=138–207s) | Abordagem 3 | **Abordagem 4** |
|---|---|---|
| concorrência mediana | 20 | **2** |
| concorrência média | 98 | **14** |
| concorrência p95 | 255 | **90** |
| slots usados (mediana) | 40 de 512 | **4 de 512** |
| p50 mediano por segundo | 11,5 ms | **1,0 ms** |
| pior segundo (p50) | 759 ms | **125 ms** |

A segunda fila drenando em paralelo não reduziu a concorrência pela metade — ela
a reduziu em **10×**. O motivo é que `L = λ × W` se retroalimenta: quando a fila
esvazia mais rápido, a latência cai, e latência menor significa menos requisições
coexistindo, o que faz a fila esvaziar ainda mais rápido. O efeito é multiplicativo
enquanto o sistema estiver fora da saturação.

### A pergunta dos 2× não pôde ser respondida

A abordagem 4 era o teste do diagnóstico da abordagem 2: sem o `Seq Scan`
encarecendo, a segunda réplica deveria render perto de 2× em vez dos 1,28×
medidos lá. **O teste não permitiu medir isso.**

| | Abordagem 3 | Abordagem 4 |
|---|---|---|
| Vazão máxima com 100% de sucesso | 1.257 req/s | 1.256 req/s |
| Segundo em que aconteceu | t=205s | t=205s |
| Injeção nesse segundo | 740 u/s (máximo) | 740 u/s (máximo) |

As duas abordagens chegaram ao mesmo número, no mesmo segundo — o **último** da
corrida, quando a rampa do Gatling atinge seu teto de 740 usuários/s. Isso não é
coincidência nem empate: as duas entregaram tudo o que foi oferecido.

**O limitador da vazão deixou de ser o sistema e passou a ser o teste.** A partir
da abordagem 3, "vazão máxima com 100% de sucesso" parou de medir capacidade e
passou a medir a rampa do Gatling. É por isso que o ganho da réplica aparece na
tabela de concorrência e latência, e não na de vazão: sobrou capacidade que a
carga não chegou a exercitar.

Isso vale para a **vazão**, não para o sistema inteiro. A [abordagem
6](#abordagem-6--pool-de-conexões-pgpool) mostrou depois que ainda havia um
gargalo real aqui — os picos de concorrência da conexão única, que levavam os
slots do nginx a 500 de 512 e produziram as 49 falhas. Ele não aparecia na vazão
porque não limitava a vazão; limitava a cauda.

A vazão por terço mostra o mesmo de outro ângulo — o sistema acompanha a carga do
início ao fim, sem inflexão:

| Terço | Abord. 1 | Abord. 2 | Abord. 3 | **Abord. 4** |
|---|---|---|---|---|
| início | 116 req/s | 128 req/s | 110 req/s | **111 req/s** |
| meio | 448 req/s | 561 req/s | 546 req/s | **551 req/s** |
| fim | 253 req/s | 391 req/s | 854 req/s | **1.003 req/s** |

### O índice continua com metade das buscas em `Seq Scan`

Mesmo padrão da abordagem 3, e pelo mesmo motivo — o planner escolhe varrer quando
o termo é comum e o `LIMIT 50` se satisfaz cedo:

```
seq_scan            : 4.914   (51%)
idx_pessoas_busca   : 4.678   (49%)   —  20 MB
```

O custo do `INSERT` ficou em 0,82 ms, contra 0,24 ms sem o índice.

A reconciliação fecha exata:

```
Gatling KO   :     49, todos Premature close, todos em t=171s
status 201   : 46.549 = linhas no Postgres = requisições `consulta`
status 400   :  4.537 = 4.189 do `busca inválida` + 348 do `criação`
status 200   : 56.124 = 56.121 do teste + 3 chamadas de `contagem-pessoas`
```

### Próximo passo

O sistema saiu da zona em que este teste consegue medi-lo. Para voltar a ter um
gargalo observável, o caminho é **aplicar as restrições da Rinha**: 1,5 CPU e
3,0 GB distribuídos entre os quatro contêineres.

Com 1,5 CPU no total em vez das 12 da máquina, o gargalo deve reaparecer — e
provavelmente em outro lugar, já que nem o `Seq Scan` nem a fila de conexão única
são mais os dominantes. É também a primeira configuração que seria válida pelas
regras do torneio.

---

## Abordagem 5 — conexão por requisição (`try/finally`)

```
nginx (round-robin)
  ├── api1 ──┐
  └── api2 ──┴── N conexões efêmeras ── Postgres (GIN trigram, max_connections=100)
```

Mantém tudo da abordagem 4 e troca só a estratégia de conexão. Em vez de uma
conexão aberta no boot e reutilizada para sempre, cada chamada de `query()` abre
sua própria conexão e a fecha no `finally`:

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

Duas consequências opostas, e é a tensão entre elas que o teste vai resolver:

- **Some o head-of-line blocking.** Não existe mais fila única: cada requisição
  tem sua própria conexão e as queries rodam de verdade em paralelo.
- **Cada requisição paga para abrir e fechar uma conexão** — handshake TCP,
  autenticação e um processo novo forkado pelo Postgres.

O `await` antes do `client.query` é obrigatório. Sem ele, o `finally` executaria
antes de a query resolver e fecharia a conexão no meio do caminho.

**Sobre o `catch`:** deixei o erro propagar em vez de capturá-lo aqui. O handler
do `POST /pessoas` já tem o seu próprio `catch`, e é ele que transforma violação
de `UNIQUE` em `422`. Um `catch` que engolisse o erro dentro do `query()` quebraria
esse caminho — o handler receberia `undefined` e estouraria ao ler
`result.rows[0]`.

### Configuração

| | |
|---|---|
| Estratégia de banco | `pg.Client` — uma conexão por requisição, fechada no `finally` |
| Réplicas da API | 2 |
| Load balancer | nginx, upstream round-robin |
| Limites de CPU/memória | nenhum |
| Índices | PK, `UNIQUE` de `apelido` e GIN `gin_trgm_ops` sobre `busca` |
| `max_connections` do Postgres | 100 (padrão) |

### Estatísticas

| Métrica | Valor | vs. abordagem 4 |
|---|---|---|
| **Requisições** | 114.085 | −0,8% |
| **Sucesso** | 113.521 — **99,51%** | −0,45 p.p. |
| Falhas | **564** | +1.051% |
| **Usuários criados** | **45.660** | **−889** |
| Escritas perdidas silenciosamente | **71** | 0 |
| **p50** | **5 ms** | **5×** |
| p75 | 14 ms | 7× |
| p95 | 103 ms | 2,3× |
| **p99** | **203 ms** | −4% |
| máx | 679 ms | +80% |
| média | 21 ms | 2,1× |
| **Vazão máxima com 100% de sucesso** | 1.263 req/s | = |
| Vazão útil média | 548 req/s | −1% |
| **Segundos com falha** | **11 de 207** | 1 de 207 |
| Primeira falha | t=187s — 664 usuários/s | t=171s |
| Concorrência mediana (último terço) | 9 simultâneos | 2 |
| Concorrência no pico | **198 simultâneos** | 250 |
| Avisos de `worker_connections` no nginx | **0** | 31 |
| Vazão nos últimos 60s | 1.011 req/s | −2% |

### Por endpoint

| Endpoint | Requisições | OK | KO | p50 | p99 | Observação |
|---|---|---|---|---|---|---|
| criação | 54.645 | 54.645 | **0** | 5 ms | 208 ms | zero falhas — ver abaixo |
| consulta | 45.660 | 45.272 | 388 | 5 ms | 199 ms | `500` por falta de conexão |
| busca válida | 9.590 | 9.414 | 176 | 13 ms | 211 ms | `500` por falta de conexão |
| busca inválida | 4.190 | 4.190 | 0 | 1 ms | **37 ms** | não toca o banco |

### Diagnóstico

**As duas previsões se confirmaram, e a segunda é a mais interessante.**

O Postgres registrou **635 `FATAL: sorry, too many clients already`**. A
concorrência chegou a 198 requisições em voo, cada uma segurando sua própria
conexão, contra um teto de 100. As falhas ficaram todas concentradas nos últimos
20 segundos da corrida, quando a injeção passou de 660 usuários/s.

### O mesmo erro, dois relatos diferentes

Os 635 erros de conexão se dividiram assim:

```
635 FATAL: sorry, too many clients already
├── 564 nas rotas GET  → viraram 500   (sem try/catch, Express propaga)
└──  71 na rota POST   → viraram 422   (o catch do handler engoliu)
```

O endpoint `criação` fechou a corrida com **zero falhas** segundo o Gatling — e
com 71 pessoas a menos do que deveria. O `422` é resposta esperada no teste, então
ninguém contou como erro. **A escrita se perdeu sem deixar rastro no status HTTP.**

Foi exatamente a armadilha registrada na previsão. O `catch` do `POST /pessoas`
devolve `422` para qualquer erro, e até a abordagem 4 isso era inofensivo porque o
único erro possível era violação de `UNIQUE`. Assim que passou a existir um
segundo motivo de falha, o handler passou a reportar problema de infraestrutura
como erro de validação.

Os `422` da corrida se decompõem assim:

```
8.637 respostas 422
├── 5.655  validação pura (campo faltando, data inválida) — não tocam o banco
├── 1.780  apelido duplicado
├── 1.131  valor maior que o limite da coluna
└──    71  falha de conexão  ← mascarada
```

### A parede do nginx sumiu

Zero avisos de `worker_connections` — contra 6.762 na abordagem 3 e 31 na 4. O
gargalo migrou do load balancer para o `max_connections` do Postgres. É a primeira
abordagem da série em que o nginx não aparece no diagnóstico.

### O custo do handshake apareceu onde não tem banco

O p50 global foi de 1 ms para 5 ms, coerente com os 2,6 ms medidos de sobrecarga
por requisição. Mas o número que explica melhor o que aconteceu é este:

| `busca inválida` | Abordagem 4 | Abordagem 5 |
|---|---|---|
| p99 | 6 ms | **37 ms** |

Esse endpoint responde `400` no primeiro `if` do handler, sem `await` e sem tocar
o banco. Ele ficou **6× mais lento** mesmo sem fazer I/O nenhum — porque o event
loop do Node está ocupado abrindo e fechando cerca de 1.200 conexões por segundo.
O custo da conexão não fica contido na requisição que a abriu; ele contamina todas
as outras que dividem o processo.

### A troca não compensou, e o motivo é a ordem dos experimentos

A conexão por requisição elimina o head-of-line blocking — cada requisição roda em
paralelo de verdade, sem fila. Esse era o problema central da abordagem 1, onde a
fila respondia por mais de 99% da latência.

**Mas esse problema já não existia.** O índice GIN tornou as queries tão baratas
(0,13 ms na busca) que a fila da conexão única deixou de ser gargalo — a abordagem
4 rodou com concorrência mediana de 2 e p50 de 1 ms. Não havia fila para eliminar.

O resultado é uma troca sem contrapartida:

| | Abordagem 4 | Abordagem 5 |
|---|---|---|
| p50 | 1 ms | 5 ms |
| p95 | 45 ms | 103 ms |
| Usuários criados | 46.549 | 45.660 |
| Falhas | 49 | 564 |
| Ganho de paralelismo | — | irrelevante |

A lição não é que conexão por requisição seja ruim em toda situação — é que **a
mesma mudança tem sinais opostos dependendo de onde está o gargalo**. Aplicada na
abordagem 1, provavelmente teria ajudado muito. Aplicada depois do índice, só
cobrou o preço.

A reconciliação fecha exata:

```
Gatling KO   :    564, todos 500, todos nos últimos 20 segundos
status 201   : 45.660 = linhas no Postgres = requisições `consulta`
status 500   :    564 = 388 do `consulta` + 176 do `busca válida`
status 400   :  4.538 = 4.190 do `busca inválida` + 348 do `criação`
status 200   : 54.689 = 54.686 do teste + 3 chamadas de `contagem-pessoas`
FATAL no PG  :    635 = 564 que viraram 500 + 71 que viraram 422
```

### Próximo passo

Com o head-of-line blocking já resolvido pelo índice, o caminho natural é o
**pool de conexões** — que fica no meio termo entre as duas estratégias já
medidas: reaproveita conexões como o `pg.Client` compartilhado, mas com mais de
uma, e com um teto configurável que impede estourar o `max_connections`.

E segue pendente a **abordagem de conformidade** com 1,5 CPU e 3,0 GB, que é a
única forma de voltar a ter um gargalo que este teste consegue medir.

---

## Abordagem 6 — pool de conexões (`pg.Pool`)

```
nginx (round-robin)
  ├── api1 ── pool de até 10 conexões ─┐
  └── api2 ── pool de até 10 conexões ─┴── Postgres (GIN trigram, max_connections=100)
```

Terceira e última estratégia de conexão da série. É o meio-termo exato entre as
duas já medidas: reaproveita conexões como o `pg.Client` compartilhado, mas mantém
várias em vez de uma.

```js
const pool = new Pool({ ... });

export async function query(text, params) {
  return pool.query(text, params);
}
```

O `pool.query()` pega uma conexão livre, executa e devolve ao pool
automaticamente. Não há `connect` nem `end` por requisição — e por isso não há
`try/finally`: não existe recurso para liberar manualmente.

O pool é **preguiçoso**: abre conexões sob demanda até o teto e as mantém abertas
depois disso. Medido em repouso após o boot: **1 conexão**. Depois de 30
requisições concorrentes: **4 conexões**. Ele cresce até onde a carga exigir.

**Tamanho do pool: o padrão do `pg`, que é 10 por processo.** Deixei sem
configurar de propósito, para que a única variável desta rodada seja a estratégia
de conexão. Com 2 réplicas o teto agregado é 20 conexões — bem abaixo do
`max_connections = 100` que a abordagem 5 estourou.

### Configuração

| | |
|---|---|
| Estratégia de banco | `pg.Pool` — até 10 conexões por processo, padrão do driver |
| Réplicas da API | 2 |
| Load balancer | nginx, upstream round-robin |
| Limites de CPU/memória | nenhum |
| Índices | PK, `UNIQUE` de `apelido` e GIN `gin_trgm_ops` sobre `busca` |
| `max_connections` do Postgres | 100 (padrão) |
| Teto agregado de conexões | 20 de 100 |

### Estatísticas

| Métrica | Valor | vs. abordagem 4 |
|---|---|---|
| **Requisições** | 115.000 | +0,03% |
| **Sucesso** | 115.000 — **100,00%** | +0,04 p.p. |
| **Falhas** | **0** | 49 |
| **Usuários criados** | **46.580** | +31 |
| Escritas perdidas | 0 | = |
| **p50** | **1 ms** | = |
| p75 | 1 ms | −50% |
| p95 | 6 ms | **−87%** |
| **p99** | **20 ms** | **−91%** |
| máx | **117 ms** | −69% |
| média | 2 ms | −80% |
| **Vazão máxima** | 1.267 req/s ¹ | = |
| Vazão útil média | 556 req/s | +0,2% |
| **Segundos com falha** | **0 de 207** | 1 de 207 |
| Concorrência mediana (último terço) | **1 simultâneo** | 2 |
| **Concorrência no pico** | **29 simultâneos** | 250 |
| Slots do nginx no pico | **58 de 512** | 500 de 512 |
| Avisos de `worker_connections` | **0** | 31 |
| Vazão nos últimos 60s | 1.034 req/s | +0,4% |

### Por endpoint

| Endpoint | Requisições | OK | KO | p50 | p99 | Custo no Postgres |
|---|---|---|---|---|---|---|
| criação | 54.640 | 54.640 | 0 | 1 ms | **9 ms** | 0,82 ms (Insert + GIN) |
| consulta | 46.580 | 46.580 | 0 | 1 ms | **5 ms** | 0,15 ms (Index Scan) |
| busca válida | 9.590 | 9.590 | 0 | 4 ms | **37 ms** | 0,13 ms (Bitmap Index Scan) |
| busca inválida | 4.190 | 4.190 | 0 | 1 ms | 7 ms | não toca o banco |

### Diagnóstico

**100,00% de sucesso — 115.000 requisições, zero falhas.** Primeira e única
abordagem da série sem um único erro, em nenhum segundo da corrida.

O Postgres não registrou nenhum `too many clients`, e o nginx não emitiu um único
aviso de `worker_connections`. Os dois tetos que apareceram nas abordagens
anteriores ficaram fora de alcance por larga margem.

### A previsão errou na parte que importava

Registrei que "contra a abordagem 4 o ganho deve ser pequeno", porque ela já rodava
com concorrência mediana de 2 e p50 de 1 ms — quase não havia fila para o pool
eliminar. **A mediana de fato não mudou. O erro foi supor que isso tornava o ganho
pequeno.**

| Último terço (t=138–207s) | Abordagem 4 | Abordagem 5 | **Abordagem 6** |
|---|---|---|---|
| concorrência mediana | 2 | 9 | **1** |
| concorrência p95 | 90 | 149 | **4** |
| concorrência no pico | 250 | 198 | **29** |
| p50 mediano por segundo | 1,0 ms | 8,0 ms | **1,0 ms** |
| **pior segundo (p50)** | **125 ms** | 175 ms | **1,0 ms** |

A mediana era igual nas duas. O que separava a abordagem 4 do sucesso total eram
os **picos** — e era neles que estavam 100% das falhas, todos os avisos do nginx e
o p99 de 212 ms.

O pool não melhorou o caso comum; ele **eliminou o pior caso**. O p50 do pior
segundo da corrida caiu de 125 ms para 1 ms: não existe mais "pior segundo". A
distribuição virou plana.

Isso mostra o limite de raciocinar por medianas. A concorrência mediana 2 dizia
"não há fila", e estava certa — na mediana. Mas 5% do tempo a fila chegava a 90
requisições, e é isso que produz p99 ruim e falha. **Uma métrica de tendência
central não consegue prever o comportamento na cauda.**

### O que aconteceu com o head-of-line blocking

O `pg.Client` compartilhado despacha uma query por vez. Enquanto a carga é leve,
isso não aparece — a fila esvazia entre as chegadas. Num pico, as requisições
chegam mais rápido do que a única conexão consegue despachar, a fila cresce, a
latência sobe, e por `L = λ × W` a concorrência sobe junto, até encostar nos 512
slots do nginx.

Com 10 conexões por processo, o pico é absorvido: **o pico de concorrência caiu de
250 para 29**, e os slots usados de 500 para 58 — de 98% do teto do nginx para
11%. A cadeia inteira que produzia falhas desde a abordagem 1 deixou de existir.

Vale notar o quanto disso é reserva não utilizada: o teto agregado era de 20
conexões e o pico de concorrência foi 29 requisições em voo. **O pool nunca chegou
perto do próprio limite** — a fila que ele precisou absorver era muito menor que
sua capacidade.

### Comparando as três estratégias de conexão

Todas as três rodaram com 2 réplicas e o mesmo índice. A única variável foi como a
conexão é obtida:

| | `Client` compartilhado | conexão por requisição | **`Pool` (10/proc)** |
|---|---|---|---|
| Abordagem | 4 | 5 | **6** |
| Sucesso | 99,96% | 99,51% | **100,00%** |
| p50 | 1 ms | 5 ms | **1 ms** |
| p99 | 212 ms | 203 ms | **20 ms** |
| Falhas | 49 | 564 | **0** |
| Escritas perdidas | 0 | 71 | **0** |
| Gargalo atingido | slots do nginx | `max_connections` | **nenhum** |

As duas alternativas falharam por motivos opostos — a conexão única por escassez
de paralelismo nos picos, a conexão por requisição por excesso de conexões. O pool
fica no meio: reaproveita como a primeira, paraleliza como a segunda, e tem teto
configurável que impede o descontrole da segunda.

**O padrão do driver bastou.** Não configurei `max`, `idleTimeoutMillis` nem
`connectionTimeoutMillis` — os 10 por processo do padrão do `pg` já deixaram o
sistema com folga de 3× sobre o pico observado.

A reconciliação fecha exata:

```
Gatling KO   :      0
status 201   : 46.580 = linhas no Postgres = requisições `consulta`
status 400   :  4.538 = 4.190 do `busca inválida` + 348 do `criação`
status 422   :  7.712 = 1.834 duplicados + 1.150 valor longo + 4.728 validação
status 200   : 56.173 = 56.170 do teste + 3 chamadas de `contagem-pessoas`
erros no PG  :      0 de conexão
```

### Próximo passo

Com 100% de sucesso e p99 de 20 ms, este teste não consegue mais medir o sistema —
não há gargalo observável, e a vazão máxima é a rampa do Gatling, não a
capacidade da API.

Resta a **abordagem de conformidade**: 1,5 CPU e 3,0 GB distribuídos entre os
quatro contêineres, como as regras da Rinha exigem. Com 1,5 CPU em vez das 12 da
máquina, um gargalo deve reaparecer — e será o primeiro da série a ser de CPU, não
de I/O nem de configuração.

---

## Abordagem 7 — conformidade: 1,5 CPU e 3,0 GB

```
nginx      0,20 CPU / 0,3 GB
  ├── api1 0,30 CPU / 0,6 GB ── pool de 10 ─┐
  └── api2 0,30 CPU / 0,6 GB ── pool de 10 ─┴── database 0,70 CPU / 1,5 GB
```

Mantém tudo da abordagem 6 e aplica as restrições que as regras da Rinha exigem:
**1,5 unidade de CPU e 3,0 GB no total**, distribuídos entre os quatro
contêineres. É a primeira configuração da série que seria válida no torneio.

Até aqui todas as abordagens rodaram sem limite nenhum, disputando as 12 CPUs da
máquina com o próprio gerador de carga. Agora a aplicação passa a ter **12,5% do
que tinha antes**.

### Como o orçamento foi dividido

A divisão não foi arbitrária — saiu do custo de CPU já medido com
`EXPLAIN ANALYZE` em cada endpoint:

| Endpoint | Requisições | Custo unitário | CPU total na corrida | Fatia |
|---|---|---|---|---|
| criação | 54.640 | 0,82 ms | 44,8 s | **83%** |
| consulta | 46.580 | 0,15 ms | 7,0 s | 13% |
| busca válida | 9.590 | 0,20 ms | 1,9 s | 4% |
| busca inválida | 4.190 | — | 0 s | 0% |
| **Total** | | | **53,7 s** | |

Sobre os 207 segundos da corrida isso dá 0,26 CPU em média. Mas o pico foi de
1.267 req/s contra 556 de média — fator 2,3× — então **o Postgres precisa de
~0,59 CPU no momento de maior carga**.

Daí a alocação:

| Contêiner | CPU | Memória | Justificativa |
|---|---|---|---|
| database | **0,70** | 1,5 GB | 0,59 medido no pico + 19% de folga; 83% disso é manutenção do índice GIN no `INSERT` |
| api1 | 0,30 | 0,6 GB | ~630 req/s por réplica: Express, JSON e protocolo do `pg` |
| api2 | 0,30 | 0,6 GB | idem |
| nginx | 0,20 | 0,3 GB | proxiar 1.267 req/s é trabalho barato para 1 worker |
| **Total** | **1,50** | **3,0 GB** | |

**A memória é folga pura.** Em repouso os quatro contêineres somam 135 MB —
nginx 2,5 MB, cada API 25 MB, Postgres 85 MB. Os 3,0 GB do orçamento são
irrelevantes para este workload; a disputa é inteiramente por CPU. A divisão de
memória existe só para cumprir a regra e evitar OOM em algum pico.

### Configuração

| | |
|---|---|
| Estratégia de banco | `pg.Pool` — até 10 conexões por processo |
| Réplicas da API | 2 |
| Load balancer | nginx, upstream round-robin |
| **Limites de CPU/memória** | **1,5 CPU / 3,0 GB — conforme as regras** |
| Índices | PK, `UNIQUE` de `apelido` e GIN `gin_trgm_ops` sobre `busca` |

### Estatísticas

| Métrica | Valor | vs. abordagem 6 |
|---|---|---|
| **Requisições** | 92.032 | −20,0% |
| **Sucesso** | 55.886 — **60,72%** | **−39,3 p.p.** |
| Falhas | **36.146** | 0 |
| **Usuários criados** | **23.611** | **−49,3%** |
| Escritas perdidas | 0 | = |
| **p50** | **1 ms** | = |
| p75 | 4 ms | 4× |
| p95 | 1.595 ms | 266× |
| **p99** | **2.429 ms** | **121×** |
| máx | 5.309 ms | 45× |
| média | 224 ms | 112× |
| Vazão máxima com 100% de sucesso | 902 req/s ² | 1.267 req/s |
| Vazão útil média | 266 req/s | −52% |
| **Segundos com falha** | **85 de 210** | 0 |
| **Ponto de ruptura** | **t=119s — 395 usuários/s** | não houve |
| Início da degradação | t=119s | não houve |
| Concorrência no pico | 259 (518 slots de 512) | 29 (58 slots) |
| Vazão nos últimos 60s | 262 req/s (−81% do pico) | 1.034 req/s |

² Ver a ressalva sobre os picos de drenagem no diagnóstico — este número não mede
capacidade nesta abordagem.

### Por endpoint

| Endpoint | Requisições | OK | KO | p50 | p99 |
|---|---|---|---|---|---|
| criação | 54.641 | 27.609 | 27.032 | 1 ms | 2.389 ms |
| consulta | 23.611 | 21.036 | 2.575 | 1 ms | 2.288 ms |
| busca válida | 9.590 | 4.983 | 4.607 | 2 ms | 3.091 ms |
| busca inválida | 4.190 | 2.258 | 1.932 | 1 ms | 7 ms |

### Diagnóstico

**A restrição derrubou o sistema de volta ao patamar da abordagem 1** — 60,72%
contra 59,60%. Sete rodadas de otimização foram anuladas por um limite de CPU.

O `cpu.stat` do cgroup responde exatamente onde:

| Contêiner | Concedido | Usado (média) | Uso | Períodos com throttling | Tempo congelado |
|---|---|---|---|---|---|
| **database** | 0,70 | 0,41 | 59% | **41,9%** | **808,7 s** |
| api1 | 0,30 | 0,05 | 15% | 0,2% | 0,4 s |
| api2 | 0,30 | 0,05 | 16% | 0,3% | 0,7 s |
| nginx | 0,20 | 0,04 | 20% | 0,2% | 0,1 s |
| **Total** | **1,50** | **0,54** | **36%** | | |

**O Postgres foi congelado em 42% de todas as janelas de 100 ms, somando 808
segundos de paralisação forçada numa corrida de 210 segundos** (o número passa da
duração porque conta processos paralelos). Os outros três contêineres praticamente
não sofreram throttling.

### O sistema falhou usando 36% do orçamento

Esse é o dado mais importante da rodada. **O conjunto consumiu 0,54 das 1,5 CPU
concedidas e ainda assim reprovou 39% das requisições.** Não faltou orçamento —
faltou distribuí-lo onde o trabalho estava.

Enquanto o banco era congelado quase metade do tempo, as duas APIs rodavam a 15%
da própria cota. A regra da Rinha não foi o problema; a minha divisão foi.

### Onde a estimativa errou: `Planning Time`

Calculei o orçamento a partir do `Execution Time` do `EXPLAIN ANALYZE`. Esse campo
mede só a execução do plano — **não inclui o tempo de planejar a query**, que o
Postgres paga a cada chamada.

| Query | Planning | Execution | Total | O que usei |
|---|---|---|---|---|
| busca | **1,154 ms** | 0,193 ms | 1,347 ms | 0,20 ms |
| consulta | **0,470 ms** | 0,057 ms | 0,527 ms | 0,15 ms |
| criação | 0,063 ms | 0,795 ms | 0,858 ms | 0,82 ms |

Na busca, planejar custa **6× mais que executar**. É consequência direta do índice:
com três caminhos possíveis (GIN, `Seq Scan`, PK) o planner tem mais o que avaliar,
e a query em si ficou tão barata que o planejamento passou a dominar.

Refazendo a conta com os dois campos:

```
minha estimativa : 46,6 s de CPU  →  0,59 CPU no pico  →  cabe em 0,70  ✅
custo real       : 72,2 s de CPU  →  0,78 CPU no pico  →  NÃO cabe      ❌
```

Subestimei em 1,5×. O banco precisava de mais do que recebeu justamente no pico.

### Média baixa, throttling alto — de novo a cauda

O banco usou 59% da sua cota **em média** e mesmo assim foi congelado em 42% das
janelas. Não é contradição: o throttling do Docker julga cada janela de 100 ms
isoladamente. Demanda irregular estoura a cota em algumas janelas e fica ociosa em
outras, e a média esconde as duas coisas.

É a mesma lição da [abordagem 6](#a-previsão-errou-na-parte-que-importava), agora
do lado da infraestrutura: **médias não preveem comportamento de cauda**. Um
gráfico de CPU média teria mostrado 59% e passado a impressão de folga confortável.

### A assinatura do throttling na vazão

A ruptura veio em t=119s com apenas 395 usuários/s — mais cedo que em qualquer
abordagem anterior, incluindo a primeira. Depois disso o comportamento fica
serrilhado de um jeito característico:

| t | ok/s | ko/s | p50 |
|---|---|---|---|
| 193 | 129 | 634 | 1.690 ms |
| 194 | 190 | 612 | 1.403 ms |
| **195** | **1.356** | **124** | **2 ms** |
| **196** | **583** | **121** | **1 ms** |
| 197 | 177 | 625 | 789 ms |

Os segundos 195 e 196 não são recuperação — são **drenagem**. A fila acumulada
durante o congelamento escoa de uma vez quando o banco volta a receber CPU, com
latência baixíssima porque as queries em si continuam baratas. Depois a fila
recomeça.

É por isso que a "vazão máxima com 100% de sucesso" desta rodada, 902 req/s, não
mede capacidade: é o tamanho de uma rajada de drenagem, não uma vazão sustentável.

### O gargalo migrou de novo

Os 35.357 avisos de `worker_connections` e as 259 requisições simultâneas (518 dos
512 slots) reproduzem exatamente o padrão das abordagens 1 a 3. Mas a causa é
outra: antes era o `Seq Scan`, agora é o throttling. A cadeia é a mesma —

```
CPU congelada → latência alta → L = λ × W infla a concorrência
              → 512 slots esgotam → nginx fecha o socket
```

O Postgres não registrou nenhum erro de conexão: o pool continuou saudável. O
problema não foi acesso ao banco, foi o banco não ter CPU para atender.

A reconciliação fecha exata:

```
Gatling KO   : 36.146 = 36.002 Premature close + 144 status 500
status 500   :    144 = worker_connections ao conectar no upstream
status 201   : 23.611 = linhas no Postgres = requisições `consulta`
status 400   :  2.457 = 2.258 do `busca inválida` + 199 do `criação`
erros no PG  :      0 de conexão
```

### Próximo passo

A correção é redistribuir o orçamento seguindo o consumo medido, sem mexer no
total de 1,5 CPU:

| Contêiner | Atual | Usado | **Proposta** | Folga sobre o pico |
|---|---|---|---|---|
| database | 0,70 | 0,41 | **1,00** | 28% sobre os 0,78 do pico |
| api1 | 0,30 | 0,05 | **0,20** | 4× |
| api2 | 0,30 | 0,05 | **0,20** | 4× |
| nginx | 0,20 | 0,04 | **0,10** | 2,5× |
| **Total** | **1,50** | 0,54 | **1,50** | |

E há uma otimização de aplicação que a rodada revelou: **`Planning Time` domina
duas das três queries**. Um `PREPARE` (ou os prepared statements do `pg`, via a
opção `name` na query) planeja uma vez e reutiliza, o que atacaria 1,15 ms dos
1,35 ms da busca. É o primeiro gargalo da série que está no Postgres mas não é
nem I/O nem índice.

---

## Abordagem 8 — conformidade com orçamento redistribuído

```
nginx      0,10 CPU / 0,3 GB
  ├── api1 0,20 CPU / 0,6 GB ── pool de 10 ─┐
  └── api2 0,20 CPU / 0,6 GB ── pool de 10 ─┴── database 1,00 CPU / 1,5 GB
```

Mesmo total de 1,5 CPU e 3,0 GB da abordagem 7, redistribuído segundo o consumo
que o `cpu.stat` mediu. Nada mudou no código, no índice ou na topologia — **a
única variável é para onde o orçamento vai**.

| Contêiner | Abordagem 7 | Usado lá | **Abordagem 8** | Folga sobre a demanda de pico |
|---|---|---|---|---|
| database | 0,70 | 0,41 (throttled 42%) | **1,00** | 28% sobre os 0,78 do pico |
| api1 | 0,30 | 0,05 | **0,20** | 4× |
| api2 | 0,30 | 0,05 | **0,20** | 4× |
| nginx | 0,20 | 0,04 | **0,10** | 2,5× |
| **Total** | 1,50 | 0,54 | **1,50** | |

A abordagem 7 falhou consumindo 36% do orçamento: o banco era congelado em 42% das
janelas de 100 ms enquanto as APIs rodavam a 15% da própria cota. Esta rodada
testa se o problema era mesmo distribuição, e não escassez.

### Configuração

| | |
|---|---|
| Estratégia de banco | `pg.Pool` — até 10 conexões por processo |
| Réplicas da API | 2 |
| Load balancer | nginx, upstream round-robin |
| **Limites de CPU/memória** | **1,5 CPU / 3,0 GB — conforme as regras** |
| Índices | PK, `UNIQUE` de `apelido` e GIN `gin_trgm_ops` sobre `busca` |

### Estatísticas

| Métrica | Valor | vs. abordagem 7 |
|---|---|---|
| **Requisições** | 99.010 | +7,6% |
| **Sucesso** | 73.802 — **74,54%** | **+13,8 p.p.** |
| Falhas | 25.208 | −30,3% |
| **Usuários criados** | **30.603** | **+29,6%** |
| Escritas perdidas | 0 | = |
| **p50** | **1 ms** | = |
| p75 | 52 ms | 13× |
| p95 | 1.090 ms | −32% |
| **p99** | **1.590 ms** | **−35%** |
| máx | 3.114 ms | −41% |
| média | 167 ms | −25% |
| Vazão máxima com 100% de sucesso | 1.600 req/s ² | 902 req/s |
| Vazão útil média | 355 req/s | +33% |
| **Segundos com falha** | 68 de 208 | 85 de 210 |
| **Ruptura sustentada** | **t=145s — 499 usuários/s** | t=119s — 395 u/s |
| Primeira falha isolada | t=126s | t=119s |
| Início da degradação | t=132s | t=119s |
| Concorrência no pico | 420 | 259 |
| Vazão nos últimos 60s | 431 req/s | 262 req/s |

### Por endpoint

| Endpoint | Requisições | OK | KO | p50 | p99 |
|---|---|---|---|---|---|
| criação | 54.627 | 35.813 | 18.814 | 1 ms | 1.504 ms |
| consulta | 30.603 | 28.749 | 1.854 | 1 ms | 1.473 ms |
| busca válida | 9.590 | 6.378 | 3.212 | 6 ms | 1.898 ms |
| busca inválida | 4.190 | 2.862 | 1.328 | 1 ms | 273 ms |

### Diagnóstico

**Redistribuir funcionou — mas metade do previsto.** O diagnóstico estava certo na
direção e errado na magnitude:

| | Abordagem 7 | **Abordagem 8** |
|---|---|---|
| Sucesso | 60,72% | **74,54%** |
| Usuários criados | 23.611 | **30.603** |
| Ruptura sustentada | t=119s | **t=145s** |
| Throttling do banco | 41,9% | **33,9%** |
| CPU do banco (média) | 0,41 de 0,70 | **0,51 de 1,00** |

Trinta por cento mais CPU no banco comprou 26 segundos de sobrevivência e 7 mil
pessoas a mais. Mas **a previsão de "throttling perto de zero" errou feio: caiu de
42% para 34%.**

### Por que 1,00 CPU não bastou, mesmo com uso médio de 51%

O banco consumiu 107 s de CPU em 211 s — **51% da cota** — e ainda assim foi
congelado em um terço das janelas. O mesmo paradoxo da abordagem 7, agora com uma
explicação mais concreta.

A cota de 1,00 CPU significa **100 ms de CPU a cada janela de 100 ms**. Mas o
Postgres é multiprocesso: com 2 réplicas × 10 conexões no pool, até **20 backends**
podem estar prontos para rodar na mesma janela. Se cinco deles quiserem 30 ms
cada, a demanda instantânea é de 150 ms numa janela de 100 ms — a cota acaba antes
do fim e todos congelam juntos.

```
cota    : 100 ms de CPU por janela de 100 ms
demanda : N backends x tempo de cada query, simultâneos
```

**A média não vê isso.** Em metade das janelas o banco fica quase ocioso, na outra
metade quer mais de uma CPU inteira. É a terceira vez na série que uma métrica de
tendência central esconde o comportamento que importa.

### O corte do nginx cobrou seu preço

| | Abordagem 7 (0,20) | Abordagem 8 (0,10) |
|---|---|---|
| Throttling do nginx | 0,2% | **5,4%** |
| Tempo congelado | 0,1 s | 6,6 s |

Cortar o nginx pela metade fez o throttling dele subir 27×. Ainda é pequeno perto
dos 34% do banco, mas explica um efeito colateral visível: a concorrência de pico
subiu de 259 para **420**. Com menos CPU, o nginx demora mais até para recusar
conexões, então elas se acumulam em vez de serem descartadas rápido.

Aparece também no `busca inválida`, que não toca o banco e mesmo assim teve p99 de
**273 ms** — contra 7 ms na abordagem 7. Esse endpoint só pode ser afetado por
throttling do nginx ou do Node.

### O sistema ainda falha usando 45% do orçamento

| Contêiner | Concedido | Usado | Uso | Throttling |
|---|---|---|---|---|
| database | 1,00 | 0,51 | 51% | **33,9%** |
| api1 | 0,20 | 0,06 | 30% | 1,9% |
| api2 | 0,20 | 0,06 | 30% | 1,6% |
| nginx | 0,10 | 0,05 | 45% | 5,4% |
| **Total** | **1,50** | **0,67** | **45%** | |

Melhorou de 36% para 45%, mas o padrão persiste: **nenhum contêiner chega perto de
saturar a média, e mesmo assim um quarto das requisições falha**. Continuar
movendo CPU entre contêineres tem retorno decrescente — as APIs já estão em 30% da
cota, não há muito mais o que tirar delas.

O caminho deixou de ser distribuir melhor. Passou a ser **fazer menos trabalho**.

### O alvo: 27% da CPU do banco é planejamento de query

Somando o `Planning Time` de cada endpoint pelo volume desta corrida:

| Query | Chamadas | Planning unitário | CPU só de planejamento |
|---|---|---|---|
| consulta | 30.603 | 0,470 ms | **14,4 s** |
| busca válida | 9.590 | 1,154 ms | **11,1 s** |
| criação | 54.627 | 0,063 ms | 3,4 s |
| **Total** | | | **28,9 s de 107 s = 27%** |

**Mais de um quarto da CPU do banco é gasto decidindo como executar queries que
não mudam nunca.** As três são fixas, com os mesmos parâmetros posicionais a cada
chamada — o plano poderia ser calculado uma vez e reutilizado.

A reconciliação fecha exata:

```
Gatling KO   : 25.208 = 25.041 Premature close + 167 status 500
status 500   :    167 = worker_connections ao conectar no upstream
status 201   : 30.603 = linhas no Postgres = requisições `consulta`
status 400   :  3.112 = 2.862 do `busca inválida` + 250 do `criação`
erros no PG  :      0 de conexão
```

### Próximo passo

**Prepared statements.** O driver `pg` suporta via a opção `name` na query: o
Postgres planeja na primeira chamada e reutiliza o plano nas seguintes. Ataca
diretamente os 28,9 s — cerca de 27% da CPU do banco — sem custar nada em memória
ou concorrência.

Um ajuste secundário a considerar junto: **o pool de 10 por processo pode estar
grande demais para 1,00 CPU**. Vinte backends disputando o equivalente a uma CPU
produzem justamente a rajada que estoura a janela de 100 ms. Um pool menor
enfileiraria mais na aplicação, mas com rajadas menores no banco. Vale medir
separadamente do prepared statement, uma variável por vez.

---

## Método

```
npm run bench     # reset do ambiente + teste completo
npm run report    # abre o relatório da última execução
npm run stats     # CPU/memória por container, ao vivo (segundo terminal)
```

O teste é o Gatling oficial, copiado para `stress-test/`: três cenários em
paralelo por 3min25s, com rampa até 740 usuários/s combinados.

### Regras que tornam as medições comparáveis

**O banco precisa ser zerado entre execuções.** Cinco rodadas iniciais deste
projeto oscilaram entre 99,8% e 32,5% de sucesso **sem nenhuma mudança de
código** — o volume do Postgres sobrevivia ao `docker compose down` e cada rodada
empilhava ~50 mil pessoas na tabela. Por isso `infra:down` sempre usa `-v`, e o
`bench` confere que a contagem inicial é `0`.

**O JDK precisa ser o 17.** O Gatling 3.9.5 compila a simulação em Scala 2.13.10,
que não lê class files de JDKs modernos e falha com `bad constant pool index: 0`.
O `run-test.sh` fixa o `JAVA_HOME` internamente.

### Ambiente

| | |
|---|---|
| Máquina | Apple Silicon, 12 CPUs, 24 GB |
| VM do Docker | 12 CPUs, 7,75 GB |
| Gerador de carga | Gatling 3.9.5 sobre Temurin 17, na mesma máquina |
| Postgres | 16.0-alpine |
| Node | 24.15.0-alpine |

O gerador de carga divide CPU com a aplicação, então os números absolutos não são
comparáveis com o ranking oficial (rodado em EC2). O que vale é a **comparação
entre abordagens sob condições idênticas**.

### Como ler os números

O Gatling injeta em **modelo aberto**: cria usuários numa taxa fixa olhando o
relógio, sem olhar a saúde do servidor. Se a API satura, a carga não recua — por
isso a vazão desaba em vez de estabilizar num platô.

- **Taxa de injeção** é a carga *oferecida*, não a aceita. Não confundir com
  requisições/s (cada usuário do cenário A faz até 2) nem com usuários
  simultâneos (`L = λ × W`).
- O gráfico **"Active Users"** conta todo usuário que existiu em *algum momento*
  do segundo; as métricas aqui usam o retrato instantâneo, que é o que disputa
  recursos. Na abordagem 1: `996 = 263 simultâneos + 734 criados no segundo`.
- A taxa de injeção não aparece em gráfico nenhum: vem do código da simulação. O
  instante da ruptura é visível em **"Number of responses per second"**, onde a
  faixa vermelha de KO começa.
