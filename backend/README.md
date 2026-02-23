# OpenDesk Backend (Core)

## Fluxo de sessão
1. **createSession(pcId, clientId, minutes)**
   - Faz lock transacional no PC (`SELECT FOR UPDATE`).
   - Recusa se o PC estiver `BUSY` ou `OFFLINE`.
   - Debita o valor total da sessão da wallet do cliente.
   - Cria sessão em `PENDING`.
2. **startSession(sessionId)**
   - Transiciona `PENDING → ACTIVE`.
   - Marca o PC como `BUSY`.
   - Define `startAt` e `endAt`.
3. **endSession(sessionId)**
   - Transiciona `ACTIVE → ENDED` (ou `FAILED` em caso de falha).
   - Calcula `minutesUsed` e liquidação.
   - Libera o PC para `ONLINE`.
4. **expiração automática**
   - Job a cada 30s finaliza sessões `ACTIVE` com `endAt` vencido.

## Regra de penalidade
A função `calculateSettlement` calcula a liquidação final com base em:
- `minutesPurchased`, `minutesUsed`, `pricePerHour`.
- `platformFeePercent` e `penaltyPercent`.
- `failureReason` (`HOST`, `CLIENT`, `PLATFORM`, `NONE`).

Regras:
- **Falha != HOST**: host recebe proporcional normal; cliente não recebe crédito.
- **Falha == HOST**: host recebe proporcional com penalidade; cliente recebe crédito do restante.
- Plataforma recebe taxa sobre o proporcional.

## Como simular falha do host
1. Envie `POST /hosts/:id/heartbeat` regularmente para atualizar `lastSeenAt`.
2. Pare de enviar heartbeats por mais de `HOST_HEARTBEAT_TIMEOUT_MS`.
3. O job de timeout vai:
   - Marcar PCs como `OFFLINE`.
   - Encerrar sessões `ACTIVE` com falha `HOST`.
   - Aplicar penalidade e crédito conforme regra.

## Signaling de stream proprio
- Endpoint: `POST /sessions/:id/stream/start`
- Regras:
  - exige usuario autenticado;
  - permite apenas cliente da sessao ou host dono do PC;
  - aceita somente sessao em `PENDING`/`ACTIVE`;
  - retorna `token` com expiracao, `streamId` derivado e host/portas de conexao.
- Objetivo:
  - garantir que stream/input so iniciem no ciclo de sessao;
  - impedir conexao fora de sessao.

## Relay WAN (MVP)
- Endpoint websocket: `GET /stream/relay` (`@fastify/websocket`).
- Query obrigatoria: `role`, `sessionId`, `streamId`, `token`, `userId`.
- Seguranca:
  - valida token ativo + sessao `PENDING/ACTIVE`;
  - valida `streamId` derivado do token;
  - valida papel (`client` ou `host`) contra a sessao.
- Rate limit minimo:
  - tentativas de conexao por IP/usuario/sessao;
  - throughput host->relay por segundo;
  - mensagens de controle client->host por segundo.
- `POST /sessions/:id/stream/start` agora retorna `transport.relay` e `transport.lan`.
