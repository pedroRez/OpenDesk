# OpenDesk Desktop (Tauri + React)

Este pacote contem o aplicativo desktop unico do OpenDesk, com escolha de modo Cliente ou Host.

## Requisitos
- Node.js 18+
- Rust toolchain (para Tauri)
- pnpm

## Como rodar (MVP)
1) Configure a API:
- copie `aplicativo/.env.example` para `aplicativo/.env`
- ajuste `VITE_API_URL` (ex: `http://localhost:3333`)
- (DEV) Para ignorar creditos no fluxo de reserva: `VITE_DEV_BYPASS_CREDITS=true`

2) Suba o backend (se necessario):
- `pnpm --filter backend dev`

3) Rode o desktop:
- `pnpm --filter aplicativo dev`

> O script ja compila o `host-daemon` antes de iniciar o app.

## Modos
- Na primeira execucao, escolha entre:
  - **Quero Conectar (Cliente)**
  - **Quero Ser Host (Disponibilizar PC)**
- Voce pode trocar o modo em **Configuracoes**.

## Fluxo Cliente (MVP)
- Marketplace com PCs **ONLINE**
- Detalhes do PC
- Reserva (minutos/horas) com criacao + inicio de sessao
- Sessao com status, tempo restante e botao para encerrar
- Tela interna de **Conexao** com instrucoes (sem IP/porta por padrao)

## Fluxo Host (MVP)
- Criar perfil de host
- Cadastrar PCs (specs)
- Listar PCs do host
- Botao **Ficar ONLINE/OFFLINE** por PC
- O host-daemon inicia automaticamente quando o modo Host esta ativo

## Host-daemon (heartbeat)
- Envia heartbeat a cada 10s para:
  - `POST /hosts/:id/heartbeat`
- Payload inclui `hostId`, `pcId`, `timestamp` e `version`

### Como testar
1) Entre no modo Host
2) Faca login
3) Crie o perfil de host
4) Aguarde alguns segundos
5) Verifique no backend o `lastSeenAt` do host (ex: via `GET /hosts`)

## Auth (login/register)
### Como testar login/register na Home
1) Abra o app e selecione o modo Cliente ou Host.
2) Na Home/Marketplace, use **Entrar** ou **Criar conta** no header.
3) Preencha o formulario e confirme.
4) O app deve redirecionar para `/` e mostrar o estado logado no header.

### Como checar persistencia e rotas protegidas
1) Depois de logar, feche e reabra o app: o usuario deve continuar logado.
2) Deslogue e tente abrir uma rota protegida (ex: `/host/dashboard`):
   - o app deve redirecionar para `/login?next=/host/dashboard`.
3) Ao logar, o app deve voltar para a rota solicitada via `next`.

## Observacoes
- Streaming real ainda nao esta embutido. O app usa um provider placeholder.
- Para empacotamento futuro, o `host-daemon` esta em `aplicativo/host-daemon`.
