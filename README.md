# OpenDesk

Marketplace de aluguel de PCs remotos por hora. Este monorepo contém o MVP com backend + web e placeholders para os futuros clientes.

## Estrutura
- `backend`: API Fastify + Prisma (Postgres).
- `web`: Next.js App Router.
- `client`: placeholder para app mobile/SDK.
- `host`: placeholder para Host Agent (inclui heartbeat mock).
- `aplicativo`: placeholder para app desktop (Tauri/Electron).

## Pré-requisitos
- Node.js 20+
- pnpm
- Docker (opcional, para Postgres/Redis)
- Rust (via rustup) e toolchain de build para o app desktop (Tauri)
  - Windows: Visual Studio Build Tools com "Desktop development with C++" + Windows SDK

## Configuração rápida
1. Instale dependências:
   ```bash
   pnpm install
   ```
2. Suba o Postgres (opcional, recomendado em dev):
   ```bash
   docker compose up -d
   ```
3. Configure os `.env`:
   ```bash
   cp backend/.env.example backend/.env
   cp web/.env.example web/.env
   cp host/.env.example host/.env
   ```
4. Rode migrations e seed do backend:
   **Na raiz do repo**:
   ```bash
   pnpm --filter backend prisma:migrate
   pnpm --filter backend prisma:seed
   ```
   (Alternativa: dentro de `backend/`, você pode usar `pnpm prisma:migrate` e `pnpm prisma:seed`.)
5. Execute o modo dev (backend + web):
   **Na raiz do repo**:
   ```bash
   pnpm dev
   ```

## App desktop (Tauri)
Para rodar o aplicativo desktop:
1. Garanta que Rust e o toolchain de build estão instalados.
   - Windows: instale o Visual Studio Build Tools com o workload de C++.
2. Rode:
   ```bash
   pnpm --filter aplicativo dev
   ```

A API ficará em `http://localhost:3333` e o frontend em `http://localhost:3000`.

## Backend
- Framework: Fastify + Prisma (Postgres).
- Redis é opcional (não utilizado no MVP).
- Job simples de expiração roda com `setInterval`.

### Logs (env)
- `LOG_LEVEL` (default `info`; `debug` habilita logs completos)
- `LOG_HEARTBEAT` (`off`, `sampled`, `debug`; default `sampled`)
- `HEARTBEAT_LOG_SAMPLE_SECONDS` (default `60`)
- `HTTP_LOG_IGNORE_METHODS` (default `OPTIONS`)

### Política de penalidade
Quando a falha é do host:
- `valor_proporcional = priceTotal * (minutesUsed / minutesPurchased)`
- `platformFee = valor_proporcional * PLATFORM_FEE_RATE`
- `hostPayout = (valor_proporcional - platformFee) * (1 - penaltyRate)`
- `clientCredit = (valor_proporcional - platformFee) - hostPayout`

### Endpoints principais
- `POST /auth/register` / `POST /auth/login`
- `GET/POST /hosts`
- `POST /hosts/:id/heartbeat`
- `GET/POST/PUT/DELETE /pcs`
- `GET/POST /software`
- `POST /pcs/:id/software`
- `POST /sessions` / `POST /sessions/:id/start` / `POST /sessions/:id/end` / `GET /sessions/:id`
- `GET /wallets/:userId` / `POST /wallets/:userId/tx`

## Web
- Next.js (App Router) com CSS Modules.
- Páginas básicas: Home, PC, Reserva, Sessão, Login/Register, Painel Host.

## Host Agent (mock)
Para testar o heartbeat:
```bash
HOST_ID=<id-do-host> pnpm --filter @opendesk/host dev
```

## Testes
```bash
pnpm --filter backend test
```

> Observação: os testes de lock dependem de `DATABASE_URL` configurado.

