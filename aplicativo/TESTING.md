# Checklist de Teste Manual (Desktop MVP)

## Preparacao
- Backend rodando (`pnpm --filter backend dev`).
- Desktop rodando (`pnpm --filter aplicativo dev`).
- `.env` configurado com `VITE_API_URL`.
- (DEV) Para ignorar creditos no fluxo: `VITE_DEV_BYPASS_CREDITS=true`.

## Fluxo Cliente - Marketplace e Fila
- [ ] Abrir o app e escolher modo **Cliente**.
- [ ] Criar conta ou fazer login (header mostra "Ola, ...").
- [ ] Abrir **Marketplace** e ver PCs com status ONLINE/BUSY/OFFLINE + "Fila: X".
- [ ] Clicar em **Conectar agora** em um PC ONLINE e navegar para a sessao.
- [ ] Clicar em **Conectar agora** em um PC BUSY e ver toast com posicao + navegar para a fila.
- [ ] Tela **Fila** mostra posicao e total de fila.
- [ ] Botao **Sair da fila** remove o usuario e volta ao marketplace.
- [ ] Encerrar uma sessao ativa e confirmar que o proximo da fila recebe "E sua vez!" e navega para a sessao.
- [ ] Botao **Conectar agora** desativado quando PC esta OFFLINE.

## Fluxo Cliente - Marketplace (Filtros e Favoritos)
- [ ] Filtrar por categoria (ex.: Jogos, Dev) e ver lista atualizada.
- [ ] Filtrar por software/plataforma (ex.: Steam, Photoshop) e ver lista atualizada.
- [ ] Limpar filtros e ver todos os PCs novamente.
- [ ] Favoritar um PC no card e ver a estrela ativa.
- [ ] Desfavoritar um PC e ver a estrela inativa.
- [ ] Tentar favoritar o mesmo PC duas vezes e confirmar que nao duplica.
- [ ] Abrir a area **Favoritos** e ver a lista de PCs/Hosts.
- [ ] Texto de protecao sobre jogos/softwares visivel no marketplace.
## Fluxo Cliente - Autenticacao (Senha)
- [ ] Criar conta com **senha** (email + senha + username obrigatorio) e entrar.
- [ ] Fazer login com **senha** (email + senha) e validar sucesso.
- [ ] Reset de senha (DEV): gerar token em **Esqueci minha senha**, redefinir e logar novamente.
- [ ] Se a conta estiver sem username, abrir automaticamente **Escolha seu username**.
- [ ] Definir username e ver refletido no marketplace (nome do host).
Resultado esperado: login forte, marketplace nao expoe email/nome real, username e a identidade publica.


## Fluxo Cliente - Confiabilidade
- [ ] Host novo aparece com badge **Novo** no card do PC.
- [ ] Apos >=5 sessoes concluidas, o badge muda para **Confiavel**.
- [ ] Simular queda/erro e validar que o badge muda para **Instavel**.
- [ ] Tooltip do badge explica a base do score.

## Fluxo Cliente - Streaming (Pareamento Assistido)
- [ ] Clicar em **Conectar** na sessao e ver estados: "Preparando conexao..." e "Abrindo Moonlight...".
- [ ] Se Moonlight nao for encontrado, ver mensagem pedindo configurar o path em Configuracoes.
- [ ] Abrir o modal **Inserir PIN de pareamento**, informar um PIN e enviar.
- [ ] Ver mensagem de sucesso/erro no modal.

## Streaming - Robustez (Already Running)
- [ ] Cenario A: Sunshine ja aberto -> colocar PC ONLINE -> nao duplicar processo e logar "[STREAM][HOST] sunshine already running".
- [ ] Cenario B: Moonlight ja aberto -> clicar "Conectar agora" -> nao quebrar e logar "[STREAM][CLIENT] moonlight already running, attempting reuse".

## Streaming - Paths e UX (DEV)
- [ ] HOST com Sunshine instalado e sem Moonlight -> deve funcionar (nao exigir Moonlight).
- [ ] CLIENTE com Moonlight instalado e sem Sunshine -> deve funcionar (nao exigir Sunshine).
- [ ] Campo com path errado -> **Verificar** falha -> **Procurar...** seleciona o executavel correto -> **Verificar** sucesso.
- [ ] Campo vazio -> **Localizar automaticamente** encontra e preenche o executavel (quando instalado).
Resultado esperado: nao depende mais de copy/paste de path; evita erro de barras invertidas e aspas; HOST e CLIENTE nao exigem os dois softwares no mesmo PC durante DEV.

## Streaming - Endereco Real (Host/Cliente em PCs diferentes)
- [ ] Host em um PC e cliente em outro: confirmar que o Moonlight usa o IP real do host (nao 127.0.0.1).

## Fluxo Cliente - Agendamento
- [ ] Abrir **Agendar** em um PC online e ver painel lateral.
- [ ] Ver horarios indisponiveis (availability) no painel.
- [ ] Criar reserva para data/hora futura e ver toast de sucesso.
- [ ] Tentar agendar horario conflitante e ver "Horario indisponivel".
- [ ] Tentar agendar no passado e ver erro.
- [ ] Abrir **Agendamentos** e confirmar lista de reservas do usuario.

## Fluxo Cliente - Sessao
- [ ] Sessao mostra status/tempo restante.
- [ ] Botao **Conectar** exibe instrucoes internas.
- [ ] Encerrar sessao e voltar ao marketplace com feedback.
- [ ] Com `VITE_DEV_BYPASS_CREDITS=true`, a reserva deve funcionar mesmo com saldo 0.
- [ ] Com a flag desativada, bloquear e mostrar "Saldo insuficiente".

## Cadastro automatico de PC (Host)
- [ ] Primeiro uso em um PC -> botao “Cadastrar este PC” aparece.
- [ ] Reabrir o app no mesmo PC -> reconhece localPcId e nao duplica.
- [ ] Clicar “Cadastrar este PC” -> modal de deteccao aparece com loading.
- [ ] Cancelar -> modal fecha e nada e criado no backend.
- [ ] Finalizar deteccao -> preview com CPU/RAM/GPU/Storage aparece.
- [ ] Confirmar cadastro -> cria no backend e mostra o PC no painel.
- [ ] Host cadastra 2 PCs (rodando o app em cada maquina) -> aparecem como PCs separados.
- [ ] Tentar criar PC duplicado -> bloqueado corretamente.

## Host ONLINE 1 clique
- [ ] Cadastrar PC (T1–T3), preencher conexao e clicar “Ficar ONLINE”.
- [ ] Confirmar no backend que connectAddress nao esta null.
- [ ] Cliente clica conectar e /stream/resolve retorna 200.

## Fluxo Host
- [ ] Abrir o app e escolher modo **Host**.
- [ ] Criar conta ou fazer login.
- [ ] Criar perfil de host (CTA no painel).
- [ ] Ver lista de PCs (vazia inicialmente).
- [ ] Abrir **Cadastrar PC**, preencher e salvar.
- [ ] Ver o PC listado com badge de status.
- [ ] Alternar ONLINE/OFFLINE e ver feedback visual.
- [ ] Com PC local ONLINE/BUSY, trocar modo para **Cliente** e validar que o PC local fica OFFLINE automaticamente.

## Navegacao e Estado
- [ ] Botao **Trocar modo** limpa o modo e volta para a home.
- [ ] Botao **Sair** limpa auth + modo e volta para a home.



