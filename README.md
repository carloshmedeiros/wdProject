# Desafio técnico Weduu

Serviço em Node.js, Next.js, TypeScript e React que recebe um lote de SKUs, confirma cada mensagem em menos de 600 ms e devolve preço e estoque consolidados.

## Como executar

Requisitos: Node.js 18.18+ e uma URL HTTPS pública. O fluxo medido deve rodar com o build de produção, porque o modo de desenvolvimento compila a rota na primeira chamada e atrapalha o SLA.

```bash
npm install
npm test
npm run build
npm start
```

O serviço sobe em `http://localhost:4000`. Em outro terminal:

```bash
ngrok http 4000
```

Abra `http://localhost:4000`, informe seu nome e a URL HTTPS do ngrok (sem `/check` no final) e registre. A plataforma chama `POST /check` durante o registro. Depois use **Solicitar lote**.

O resultado de cada callback fica na tela e em `reports/<run_id>.json` e `reports/latest.json`. Cole esse JSON na seção de relatório abaixo.

Variáveis opcionais, em `.env.local`:

```bash
PLATFORM_BASE_URL=https://dev-wdu-ped-test-1014944555984.us-central1.run.app
ENRICH_CONCURRENCY=3
ENRICH_MAX_ATTEMPTS=8
```

## Fluxo

1. `POST /register` na plataforma, que valida este serviço em `POST /check`.
2. `POST /burst/:cid` abre um lote e devolve `run_id` e `total`.
3. `POST /process` grava a mensagem (`run_id` + `seq`) e responde `202` sem esperar o enriquecimento.
4. Até 3 workers consultam `GET /enrich/:sku`. `429` e `5xx` voltam para a fila; `401` e `404` encerram o item.
5. Quando o número de SKUs únicos chega ao `total` e não há item em andamento, o serviço envia `POST /callback`.

## Decisões

O recebimento e o processamento ficam no mesmo processo Node, com estado em memória e uma cópia em `.data/state.json`. Para 20 SKUs isso é suficiente: o limite real está na plataforma, que aceita no máximo 3 enriquecimentos em voo e responde em 400–800 ms. Redis, RabbitMQ ou BullMQ acrescentariam um serviço à parte sem aumentar o throughput.

`/process` só faz parse, deduplicação e enfileiramento. A deduplicação usa `run_id` + `seq`. Uma reentrega de item já concluído é ignorada; uma reentrega de item que falhou de forma definitiva entra de novo na fila.

A vaga de concorrência é liberada antes da espera de retry. Assim, um `429` não ocupa um dos três slots enquanto o `retry-after` passa. O callback automático espera o lote fechar, para não gerar relatório com item faltando. Itens `404` não entram no resultado, porque inventar preço ou estoque contaria como divergência. O botão de reenvio pede outro relatório com o mesmo `run_id`.

Se o processo cair no meio do lote, a próxima subida relê `.data/state.json`, devolve à fila o que estava em consulta e só reenvia o callback se o resultado mudou.

## Trade-offs

- Um único processo perde o lote se o disco também falhar. O arquivo local cobre queda do processo, não perda da máquina.
- O tempo de ACK exibido na tela é local. A plataforma mede ponta a ponta, incluindo o túnel.
- Um SKU `404` não bloqueia o restante do lote. O relatório da plataforma pode marcar esse item como perdido.
- O callback automático não sai enquanto faltar mensagem. Duplicata não conta como mensagem nova.

## Se o lote tivesse 20.000 SKUs

Eu separaria o processo que responde `/process` dos workers de enriquecimento. O ACK gravaria `run_id:seq` com `SET NX` no Redis e publicaria o trabalho numa fila durável. A concorrência global continuaria em 3, porque esse teto é da API de enriquecimento: perto de 5 SKUs por segundo, 20.000 itens levariam cerca de uma hora, mais os retries. Aumentar workers além disso só produziria `429`.

O resultado seria persistido item a item, para um restart retomar sem repetir consulta já concluída. O callback continuaria único, disparado quando os 20.000 seqs estivessem resolvidos. Log por mensagem sairia do caminho quente.

## Relatório da execução

Lote `s9kaq6n8ocygqjzfturpdjky`, em 2026-10-06T23:34:06Z. A plataforma devolveu **score 100** na primeira tentativa. O payload completo está em `reports/latest.json`.

- 20/20 SKUs corretos, nenhum item faltando ou divergente.
- ACK: p50 402 ms, p95 469 ms, pior caso 476 ms (`seq` 13). Alvo 600 ms. Nenhum acima do alvo.
- Duplicata do `seq` 3 consultada uma única vez no enriquecimento.
- 3 respostas 500 forçadas, as 3 recuperadas.
- Nenhum 429. Concorrência dentro do limite de 3.
- Tempo total do lote: 2138 ms.

```json
{
  "ok": true,
  "score": 100,
  "attempt": 1,
  "ack": { "target_ms": 600, "p50": 402, "p95": 469, "worst": { "seq": 13, "ms": 476 }, "pass": true },
  "idempotency": { "duplicate_seq": 3, "enrich_calls": 1, "expected_calls": 1, "pass": true },
  "retry": { "forced_500": 3, "recovered": 3, "pass": true },
  "concurrency": { "limit": 3, "got_429": 0, "pass": true },
  "result": { "expected": 20, "missing": [], "mismatched": [], "pass": true },
  "duration_ms": 2138
}
```
