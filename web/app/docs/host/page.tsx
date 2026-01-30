import styles from '../docs.module.css';

export default function DocsHostPage() {
  return (
    <>
      <div className={styles.section}>
        <h1>Host: configurar Sunshine</h1>
        <p>
          O Sunshine roda no PC do host e expõe o streaming para o Moonlight.
          Configure uma vez e mantenha o PC pronto para reservas.
        </p>
      </div>

      <div className={styles.section}>
        <span className={styles.badge}>Checklist</span>
        <ul className={styles.checklist}>
          <li>Instalar Sunshine no PC do host.</li>
          <li>Definir uma senha/PIN de pareamento.</li>
          <li>Garantir que a GPU e drivers estao ok.</li>
          <li>Habilitar firewall/portas (veja "Rede e portas").</li>
        </ul>
      </div>

      <div className={styles.section}>
        <h3>Passo a passo</h3>
        <ol className={styles.steps}>
          <li>Instale o Sunshine no PC do host.</li>
          <li>Abra o Sunshine e confirme que ele esta "Online".</li>
          <li>Anote o IP/DNS publico ou local do PC.</li>
          <li>No OpenDesk, preencha connectionHost e connectionPort do PC.</li>
          <li>Deixe o PC ONLINE no painel do host.</li>
        </ol>
      </div>

      <div className={styles.section}>
        <h3>Boas praticas</h3>
        <ul className={styles.checklist}>
          <li>Use conexao cabeada sempre que possivel.</li>
          <li>Teste com o Moonlight local antes de abrir para clientes.</li>
          <li>Evite fechar o Sunshine durante uma sessao ativa.</li>
        </ul>
      </div>
    </>
  );
}
