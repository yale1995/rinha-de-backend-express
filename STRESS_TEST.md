# Como a Aplicação Será Testada

Documento de referência baseado na análise do repositório oficial da Rinha de Backend 2023/Q3 ([zanfranceschi/rinha-de-backend-2023-q3](https://github.com/zanfranceschi/rinha-de-backend-2023-q3)).

---

## Resumo executivo

- **Ferramenta**: [Gatling](https://gatling.io/) 3.9.5 (Scala / JVM).
- **Endpoint alvo**: `http://localhost:9999` (atrás do nginx).
- **Duração total**: ~3 minutos e 25 segundos.
- **Pico combinado**: **740 usuários por segundo** distribuídos em 3 cenários paralelos.
- **Restrição de recursos**: 1.5 CPU + 3.0 GB de memória total entre todos os containers (nginx + APIs + banco).
- **Validação final**: contagem de pessoas (`GET /contagem-pessoas`) precisa bater com o número de POSTs que retornaram `201`.

---

## Componentes do teste

### 1. Geração de dados — `geracao_recursos.py`

Antes de rodar o Gatling, um script Python gera dois arquivos TSV:

| Arquivo | Linhas | Conteúdo |
|---|---|---|
| `pessoas-payloads.tsv` | 100.000 | JSON completo de uma pessoa em cada linha |
| `termos-busca.tsv` | 5.000 | Strings aleatórias usadas como `?t=` |

**Mistura intencional de dados válidos e inválidos** (~1% inválidos), pra testar a validação da API:

- `apelido` com 35 caracteres (passa do limite de 32) → deve retornar `400` ou `422`.
- `nome` com 120 caracteres (passa de 100) → deve retornar `400` ou `422`.
- `nascimento` em formatos inválidos (`"12-12-2000"`, `null`, `10`, `"?!?!?"`) → `400` ou `422`.
- `stack` como string ou número em vez de array → `400`.

Esses dados não são novidade no fluxo — a API precisa rejeitar corretamente.

### 2. Simulação Gatling — `RinhaBackendSimulation.scala`

3 cenários **rodam em paralelo** com perfis de injeção independentes.

---

## Os 3 cenários

### Cenário A — `Criação E Talvez Consulta de Pessoas`

O cenário mais agressivo. Cada usuário virtual:

1. Lê uma linha de `pessoas-payloads.tsv` (em modo circular).
2. Faz `POST /pessoas` com o payload.
3. Aceita status `201`, `422` ou `400`.
4. Se foi `201`, lê o header `Location` e **espera de 1ms a 30ms**.
5. Faz `GET {Location}` (`GET /pessoas/:id`).

**Por que a pausa?** Pra dar tempo de o request chegar — e provavelmente cair em **outra instância** da API. Round-robin no nginx alterna entre api1 e api2. Se o POST foi pra api1 mas o GET cair na api2, **a api2 precisa achar o registro** que a api1 acabou de criar. Isso testa **consistência de dados** entre instâncias compartilhando o mesmo banco.

**Perfil de carga:**

| Fase | Taxa | Duração |
|---|---|---|
| Warm-up suave | 2 usuários/s constantes | 10s |
| Warm-up médio | 5 usuários/s constantes (randomizado) | 15s |
| Ramp principal | 6 → **600 usuários/s** linear | 3min |

**Pico**: 600 usuários por segundo só neste cenário.

### Cenário B — `Busca Válida de Pessoas`

Cada usuário:

1. Lê uma linha de `termos-busca.tsv`.
2. Faz `GET /pessoas?t={termo}`.
3. Qualquer resposta `2XX` é aceita.

**Perfil de carga:**

| Fase | Taxa | Duração |
|---|---|---|
| Warm-up | 2 usuários/s constantes | 25s |
| Ramp principal | 6 → **100 usuários/s** linear | 3min |

**Pico**: 100 usuários por segundo.

### Cenário C — `Busca Inválida de Pessoas`

Cada usuário:

1. Faz `GET /pessoas` (**sem o parâmetro `t`**).
2. **Espera status `400` exatamente** — se a API responder qualquer outra coisa, o teste falha.

**Perfil de carga:**

| Fase | Taxa | Duração |
|---|---|---|
| Warm-up | 2 usuários/s constantes | 25s |
| Ramp principal | 6 → **40 usuários/s** linear | 3min |

**Pico**: 40 usuários por segundo.

---

## Perfil de carga consolidado

Os 3 cenários rodam **simultaneamente**, então no pico final:

```
600 users/s (POST + GET por id)  ← cenário A
100 users/s (GET busca válida)   ← cenário B
 40 users/s (GET busca inválida) ← cenário C
──────────
740 users/s no pico combinado
```

E como cada usuário do cenário A faz **2 requests** (POST + GET), o RPS efetivo pode passar de **1.300 req/s** só no cenário A. Total no pico realista: **~1.500 req/s sustentados por minutos**.

Linha do tempo do teste:

```
0s        10s       25s                              ~3min25s
│─warmup─│─warm 2─│──────── ramp linear ─────────────│
                  │                                  │
                  │                                  └─ pico (600+100+40)
                  └─ início do ramp
```

---

## Critérios de sucesso

### Por endpoint

| Endpoint | Status aceitos | Observações |
|---|---|---|
| `POST /pessoas` | `201`, `422`, `400` | A simulação aceita qualquer um dos três — o teste valida que a API distingue entre eles corretamente |
| `GET /pessoas/:id` (após criação) | Não há check explícito de status | A consulta é registrada nas métricas mas qualquer resposta é tolerada |
| `GET /pessoas?t={t}` | `2XX` | Qualquer resposta 200 é OK |
| `GET /pessoas` (sem `t`) | **`400` estritamente** | Único endpoint com check rigoroso de status |
| `GET /contagem-pessoas` | Validação manual no fim | O `run-test.sh` faz um curl final e mostra o valor |

### Validação final (consistência de dados)

Depois que o Gatling termina, o script roda:

```bash
curl -v "http://localhost:9999/contagem-pessoas"
```

E o número retornado **precisa bater com o número de POSTs que retornaram 201** durante a corrida. Isso é o teste de **durabilidade**: nenhum registro pode ser perdido entre o que a API disse "criei" e o que o banco tem persistido. É por isso que o `INTRUÇOES.MD` proíbe explicitamente usar cache em `/contagem-pessoas` — esse endpoint é o auditor.

### Implícito mas crucial

- **Latência baixa sob carga** — embora não tenha SLA escrito, o ranking final compara quem suportou mais requisições com sucesso.
- **Zero crashes** — uma API que cair durante o ramp é descartada.
- **Consistência entre instâncias** — a consulta após criação deliberadamente vai pra instância oposta da que criou; o banco precisa servir como fonte da verdade.

---

## Como rodar localmente

### Pré-requisitos

1. **JVM 11+**:
   ```bash
   brew install openjdk@17
   ```
2. **Gatling 3.9.5** — baixar do site oficial e extrair em `~/gatling/3.9.5/`.
3. **Python 3** — pra rodar o `geracao_recursos.py`.

### Setup

```bash
# 1. Clonar o repo oficial
git clone https://github.com/zanfranceschi/rinha-de-backend-2023-q3
cd rinha-de-backend-2023-q3/stress-test

# 2. Gerar os arquivos de dados
python3 geracao_recursos.py

# 3. Subir SUA aplicação em localhost:9999
cd /Users/yalearaujo/www/others/rinha-de-backend-express
docker compose -f src/infra/compose.yaml up --build -d

# 4. Rodar o teste
cd -
./run-test.sh
```

### Saída

- Relatório HTML detalhado em `user-files/results/<timestamp>/index.html`.
- Histogramas de latência por endpoint, taxas de sucesso/erro, RPS sustentado, percentis.
- No console: o `curl /contagem-pessoas` final pra você comparar com o número de criações com sucesso.

---

## Comparação com nossos testes (oha)

O que estávamos fazendo até agora **não simula o teste real**. Diferenças importantes:

| Aspecto | Nossos testes (oha) | Teste oficial (Gatling) |
|---|---|---|
| Endpoint | 1 endpoint isolado (`/contagem-pessoas`) | 4 endpoints em paralelo |
| Payloads | Idênticos (cabem no cache) | 100k payloads únicos, mistura válido/inválido |
| Carga | Constante (`-c 50`, `-c 200`) | Ramp progressivo (warm → 740 RPS) |
| Duração | 30 segundos | 3 min 25 seg |
| Validação | Status codes apenas | Consistência entre instâncias + contagem final |
| Realismo | Baixo — exercitava cache barato | Alto — escrita real, busca real, validação real |

**Os nossos testes mostraram limites de throughput puro do front (~14k RPS no nginx)**, mas não testaram nada do que a Rinha realmente cobra:

- **Escrita concorrente** com `apelido` único (lock no índice, write-ahead log, fsync).
- **Busca por ILIKE** em colunas sem índice.
- **Consistência cross-instance** depois de criar.
- **Validação** de payloads inválidos.

Por isso o `Client` persistente parecia suficiente nos nossos testes: o trabalho era barato demais pra a serialização doer. Sob o perfil real, com queries de 5-50ms cada, a fila do `Client` único vai engasgar. **Aí entra o `Pool`.**

---

## Próximos passos sugeridos

1. **Rodar o Gatling oficial uma vez** — pra ter um número-base do "estado de hoje" antes de mais otimizações.
2. **Migrar `database.js` de `Client` para `Pool`** — o teste com escrita vai forçar isso.
3. **Aplicar limites de CPU/memória** (1.5 CPU + 3 GB total) no `compose.yaml` — sem isso o teste local mente, porque sua máquina tem muito mais recurso do que a EC2 onde o teste oficial roda.
4. **Tunar nginx** (`worker_processes auto;`, `worker_connections 1024;`) — único arquivo de configuração que pode dar ganho fácil.
5. **Otimizar a busca** (`/pessoas?t=`) — sem índice apropriado, o ILIKE em 3 colunas vira full-table-scan. Considerar `pg_trgm` + GIN index, ou uma coluna `tsvector`/`text` agregada.
6. **Validação de tamanhos** no `POST /pessoas` (apelido ≤ 32, nome ≤ 100) — sem isso, payloads longos batem em erro do Postgres em vez de retornar `422`/`400` apropriado.

---

## Referências

- [Repo oficial Rinha 2023/Q3](https://github.com/zanfranceschi/rinha-de-backend-2023-q3)
- [Pasta stress-test/](https://github.com/zanfranceschi/rinha-de-backend-2023-q3/tree/main/stress-test)
- [Simulação Gatling](https://github.com/zanfranceschi/rinha-de-backend-2023-q3/blob/main/stress-test/user-files/simulations/rinhabackend/RinhaBackendSimulation.scala)
- [Documentação do Gatling 3.9](https://docs.gatling.io/)
