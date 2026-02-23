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

## Host-daemon (capture preview local)

Objetivo: validar pipeline local de captura no Windows usando Desktop Duplication (`ffmpeg ddagrab`) com metricas de estabilidade.

### Requisitos adicionais
- Windows
- `ffmpeg` no `PATH` com filtro `ddagrab` habilitado

### Comando rapido (20s)
```bash
pnpm --filter aplicativo host-daemon:capture-preview:quick
```

### Comando de aceite (5 min @ 30 FPS)
```bash
pnpm --filter aplicativo host-daemon:capture-preview
```

### Modo CLI direto (opcoes)
```bash
pnpm --filter aplicativo host-daemon:build
node host-daemon/dist/index.js --mode capture-preview --fps 30 --duration-sec 300 --pixel-format nv12
```

Opcoes uteis:
- `--output <arquivo>`: caminho do mp4 de preview.
- `--pixel-format nv12|rgba`: formato interno de conversao do frame.
- `--width <n> --height <n>`: resolucao alvo.
- `--output-idx <n>`: monitor de captura (multi-monitor).
- `--stall-timeout-sec <n>`: timeout para detectar travamento (default `5`).
- `--encoder <nome>`: forca encoder (`h264_nvenc`, `libx264`, `mpeg4`).
- `--open-preview true`: abre o arquivo ao finalizar.

### Metricas emitidas (stdout JSON)
- `capture_progress`: FPS observado/reportado, `droppedFrames`, `duplicatedFrames`, `frame`, `elapsedSec`.
- `capture_summary`: resumo final com `fpsAvg`, `fpsMin`, `fpsMax`, `framesCaptured`, `droppedFramesReported`, `droppedFramesEstimated`, `meetsFpsThreshold`, `stableAtTarget30Fps`.
- `capture_stall`: emitido se ficar sem avancar frames por mais de `stall-timeout-sec`.

## Host-daemon (encoder H.264)

O daemon possui modulo de encoder com selecao automatica:
- NVIDIA -> `h264_nvenc` (hardware), quando disponivel.
- AMD -> `h264_amf` (hardware), quando disponivel.
- Fallback software para DEV -> `libx264`, depois `libopenh264`.

Configuracoes suportadas:
- bitrate (`--bitrate-kbps`)
- keyframe interval (`--keyint`)
- profile (`--profile baseline|main`)
- output Annex B com NAL units + SPS/PPS periodicos em keyframe

### Selftest do encoder (gera .h264 reproduzivel)
```bash
pnpm --filter aplicativo host-daemon:h264-selftest:quick
pnpm --filter aplicativo host-daemon:h264-selftest
```

Comando equivalente:
```bash
pnpm --filter aplicativo host-daemon:build
node host-daemon/dist/index.js --mode h264-selftest --width 1280 --height 720 --fps 30 --duration-sec 15 --bitrate-kbps 6000 --profile baseline --pixel-format nv12
```

### Metricas do selftest
- `h264_selftest_start`: encoder escolhido (auto/manual), vendor GPU, perfil, bitrate, keyint.
- `h264_selftest_summary`: FPS de ingestao, bitrate real de saida, chunks/NALUs, keyframes e chunks com SPS/PPS.

## Transporte direto LAN (UDP H.264)

Implementado no host-daemon:
- Host envia H.264 Annex B em UDP com packetizacao por chunks.
- Cliente recebe UDP, faz reassembly por `seq` e decodifica em player (`ffplay`) ou decoder headless (`ffmpeg`).
- Politica de baixa latencia: frame incompleto e descartado rapidamente (`max-frame-age-ms`), sem bloquear fila.

### Header do protocolo (v1)
- `streamId` (16 bytes)
- `seq` (`u32`)
- `timestampUs` (`u64`)
- `flags` (`u8`) com bit `keyframe`
- `chunkIndex` (`u16`)
- `totalChunks` (`u16`)
- `payloadSize` (`u16`)

### Rodar cliente (receptor/decoder)
```bash
pnpm --filter aplicativo host-daemon:udp-lan:client
```

### Rodar host (sender UDP)
```bash
pnpm --filter aplicativo host-daemon:udp-lan:host
```

### Teste rapido local (loopback)
Terminal 1:
```bash
pnpm --filter aplicativo host-daemon:udp-lan:client:quick
```
Terminal 2:
```bash
pnpm --filter aplicativo host-daemon:udp-lan:host:quick
```

### Opcoes uteis (host)
- `--target-host` / `--target-port`
- `--stream-id <uuid>` (fixa stream para casar no cliente)
- `--max-payload-bytes <n>` (chunk UDP)
- `--pacing-kbps <n>` (evita burst)
- `--bitrate-kbps`, `--keyint`, `--profile`, `--pixel-format`
- `--auth-token <token>` / `--auth-expires-at-ms <epoch_ms>` (feedback autenticado)
- `--session-id <id>` (vincula feedback a sessao)
- `--min-bitrate-kbps <n>`, `--bitrate-step-pct <0.55..0.98>`, `--bitrate-adapt-cooldown-ms <n>`

### Opcoes uteis (cliente)
- `--listen-host` / `--listen-port`
- `--stream-id <uuid>` (filtra stream especifico)
- `--decoder ffplay|ffmpeg-null|none`
- `--max-frame-age-ms <n>` (drop de incompletos)
- `--max-pending-frames <n>`
- `--output <arquivo.h264>` (salva Annex B reagrupado)

### Metricas emitidas
- Host:
  - `udp_sender_stats` e `udp_sender_summary` (kbps, packetRate, pacingWaitMs, fps).
- Cliente:
  - `udp_receiver_stats` e `udp_receiver_summary` com:
    - `lossPct` (estimado por chunks faltantes)
    - `jitterMs`
    - `fpsAssembled`
    - `fpsDecodeEstimate` e `fpsDecodeReported` (quando disponivel do decoder/player)

### Resiliencia minima (MVP)
- **Request de keyframe (IDR)**:
  - Cliente detecta freeze no decode/render e envia feedback UDP `keyframe_request`.
  - Host processa feedback autenticado e recria encoder para forcar IDR imediato no proximo frame.
- **Adaptacao simples de bitrate**:
  - Cliente envia `network_report` com `lossPct` e `jitterMs` quando degradado.
  - Host reduz bitrate (step percentual, com cooldown) e aplica novo encoder + IDR.
- **Reconexao limpa**:
  - Cliente tenta reconectar automaticamente sem encerrar sessao.
  - Token e expiracao continuam obrigatorios; reconexao automatica para quando token expira.

Feedback UDP (cliente -> host sender):
- comando Tauri: `send_udp_lan_feedback`
- payload:
  - `type`: `keyframe_request` | `network_report` | `reconnect`
  - `token` (obrigatorio)
  - `sessionId`/`streamId` (opcionais, recomendados)
  - `lossPct`, `jitterMs`, `freezeMs`, `requestedBitrateKbps`, `reason`

Validacao no host:
- Se configurado `--auth-token`, feedback sem token valido e rejeitado.
- Se configurado `--session-id`, feedback sem sessionId correspondente e rejeitado.
- `streamId` divergente e rejeitado.

### Player dentro do OpenDesk (Tauri)
- A tela `Conexao` agora possui **Player Nativo LAN (Experimental)**.
- O player:
  - recebe UDP pelo runtime Tauri (sem app externo),
  - decodifica H.264 via WebCodecs (tentando hardware primeiro),
  - faz fallback para modo software quando necessario,
  - renderiza em `canvas` dentro da UI com buffer curto (drop de delta quando fila cresce),
  - envia feedback de resiliencia (keyframe/network/reconnect) ao host via UDP.

## Canal de Input LAN (Cliente -> Host)

Implementado no runtime Tauri com **canal separado TCP** (nao multiplexado com video UDP):
- Cliente captura mouse/teclado no player e envia eventos JSON por socket TCP.
- Host autentica, aplica regras de sessao/rate-limit e injeta input no Windows via `SendInput`.
- Hotkey de desconectar no cliente: `Ctrl + Shift + Q`.

### Protocolo de input (v1)

Fluxo:
1. Cliente conecta em `host:port` (padrao `5505`).
2. Primeiro pacote obrigatorio: `auth`.
3. Host responde `auth_ok` ou `auth_error`.
4. Cliente envia eventos (`mouse_move`, `mouse_button`, `mouse_wheel`, `key`, `disconnect_hotkey`).

Mensagens:
- `auth`:
  - `token` (obrigatorio)
  - `sessionId` (opcional, recomendado)
  - `streamId` (opcional)
  - `version` (atual `1`)
- Eventos:
  - `mouse_move`: `seq`, `tsUs`, `dx`, `dy`
  - `mouse_button`: `seq`, `tsUs`, `button`, `down`
  - `mouse_wheel`: `seq`, `tsUs`, `deltaX`, `deltaY`
  - `key`: `seq`, `tsUs`, `code`, `down`, modificadores opcionais (`ctrl/alt/shift/meta`)
  - `disconnect_hotkey`: `seq`, `tsUs`

### Regras de seguranca e controle
- Input so entra quando:
  - token bate com o servidor (`authToken`);
  - sessao do servidor esta `ACTIVE`;
  - (se configurado) `sessionId` e `streamId` batem com o esperado.
- `rate limit` no host (padrao `700 events/s`): excedente e descartado.
- Quando `session ACTIVE` = `false`, eventos sao descartados (`eventsDroppedInactive`).

### Integracao no app
- **Host Dashboard**:
  - painel `Servidor de Input LAN (TCP)` para bind/porta/token/sessionId/streamId/rate-limit.
  - sincroniza `session ACTIVE` com estado `BUSY` do host (bloqueia input fora de sessao ativa).
  - metricas em tempo real: auth failures, injected, dropped, inject errors.
- **Connection (cliente)**:
  - `LanNativePlayer` conecta no UDP (video) e no TCP (input).
  - envia mouse/teclado com throttling (mouse move em janela curta) e drop quando fila de envio cresce.
  - renderiza status/metricas de input (`events/s`, `sent`, `dropped`, `send errors`).

### IPC/Comandos Tauri (input)
- Servidor host:
  - `start_lan_input_server`
  - `stop_lan_input_server`
  - `set_lan_input_server_session_active`
- Cliente:
  - `start_lan_input_client`
  - `send_lan_input_event`
  - `stop_lan_input_client`
- Eventos emitidos:
  - `lan-input-server-status`
  - `lan-input-server-stats`
  - `lan-input-client-status`
  - `lan-input-error`

## Integracao com Sessao (Signaling)

Novo endpoint de signaling no backend:
- `POST /sessions/:id/stream/start`
- Retorna credenciais do stream proprio:
  - `host`, `videoPort`, `inputPort`
  - `streamId`
  - `token` + `tokenExpiresAt`
  - `streamState` (`STARTING` ou `ACTIVE`)

Regras aplicadas:
- So responde para sessao `PENDING`/`ACTIVE`.
- Sessao fora desse estado bloqueia conexao (`409`).
- Cliente e host dono do PC podem consultar a sinalizacao da sessao.

Comportamento no app:
- Cliente (Connection) sincroniza sinalizacao antes de conectar o player nativo.
- Player nativo bloqueia conexao fora de `ACTIVE/STARTING`.
- Host sincroniza token/sessionId/streamId no painel de input.
- Input server valida `token`, `sessionId`, `streamId` e expiracao do token.
- Ao sessao sair de `ACTIVE/PENDING`:
  - cliente desconecta automaticamente o player nativo,
  - host para automaticamente o servidor de input LAN.

Fallback:
- Se o stream proprio falhar, o fluxo Sunshine/Moonlight permanece disponivel na mesma tela.

## WAN Relay (fora da LAN)

Escolha atual para NAT traversal: **Relay via backend (WebSocket)**.

Implementado:
- Backend `GET /stream/relay` com salas por `sessionId + streamId`.
- Auth por sessao/token/streamId/userId (role `host` ou `client`).
- Rate limit basico de conexao e throughput/mensagens.
- `POST /sessions/:id/stream/start` agora retorna `transport.relay` + `transport.lan`.

Player cliente:
- `LanNativePlayer` suporta `transportMode='relay'`.
- Recebe frames H.264 Annex B do relay e decodifica no mesmo pipeline WebCodecs.
- Envia feedback (`keyframe_request`, `network_report`, `reconnect`) pelo WS.

Host sender:
- Novo modo daemon: `relay-host` (`aplicativo/host-daemon/src/transport/relayHost.ts`).
- Envia video em binario no formato `relay_h264_annexb_v1`:
  - byte 0: flags (`keyframe`),
  - bytes 1..8: `timestampUs` (u64 BE),
  - bytes 9..: payload Annex B.

Comando base de teste:
```bash
pnpm --filter aplicativo host-daemon:relay:host
```

Preencher no comando:
- `--relay-url`
- `--session-id`
- `--user-id`
- `--stream-id`
- `--auth-token`

Obs:
- Input remoto via relay ainda nao foi habilitado nesta etapa (LAN input permanece disponivel).

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
