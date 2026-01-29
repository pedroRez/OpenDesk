# OpenDesk Host Agent

Placeholder para o futuro agente do host.

## Heartbeat mock
Este script envia um heartbeat periódico ao backend para fins de teste.

```bash
HOST_ID=<id-do-host> HEARTBEAT_API_URL=http://localhost:3333 pnpm --filter @opendesk/host dev
```

O endpoint utilizado é `POST /hosts/:id/heartbeat` e atualiza o status das máquinas do host.
