# OpenDesk Web

## Rodar em dev
1. Na raiz do repo:
   ```bash
   pnpm install
   pnpm dev
   ```
2. Acesse:
   - Web: http://localhost:3000
   - API: http://localhost:3333

> A web usa um auth mock: guarda o `userId` no `localStorage` e envia o header `x-user-id` nas requests.

## Teste de autenticacao e permissoes
1. Abra `/register`, crie uma conta.
   - Deve redirecionar para `/`.
   - O header mostra `Ola, <nome/email>` e o botao `Sair`.
2. Clique `Sair`.
   - O header volta para `Entrar / Criar conta`.
3. Tente acessar `/host/dashboard` sem logar.
   - Deve redirecionar para `/login?next=/host/dashboard`.
4. Logue e volte para `/host/dashboard`.
   - Se nao for host, aparece o CTA `Quero ser host`.
   - Clique para criar o perfil de host.
5. Cadastre um PC.
   - Ele aparece na lista `Seus PCs`.
   - Use o toggle para `Ficar Online/Offline` (BUSY bloqueia offline).
6. Reserve um PC:
   - Acesse um PC no marketplace e clique `Reservar`.
   - O userId e usado automaticamente (sem digitar ID).

## Teste de streaming (MVP com Sunshine/Moonlight)
1. Host instala Sunshine no PC (manual).
2. Cliente instala Moonlight no dispositivo (manual).
3. Host cadastra o PC com:
   - `connectionHost` (IP/DNS)
   - `connectionPort` (ex: 47990)
   - `connectionNotes` (opcional)
4. Cliente reserva a sessao e abre a pagina `/sessao/<id>`.
5. Cliente usa os dados na tela para conectar via Moonlight.
6. Se falhar, veja `/docs/rede` e `/docs/falhas`.
