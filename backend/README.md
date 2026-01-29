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
