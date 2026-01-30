import styles from './docs.module.css';

export default function DocsIndexPage() {
  return (
    <>
      <div className={styles.section}>
        <h1>Documentacao de conexao</h1>
        <p>
          Esta area explica como usar Sunshine (host) e Moonlight (cliente) para
          conectar ao PC remoto no MVP.
        </p>
      </div>

      <div className={styles.section}>
        <span className={styles.badge}>Checklist rapido</span>
        <ul className={styles.checklist}>
          <li>Host instalou Sunshine e liberou portas.</li>
          <li>Host cadastrou o PC no painel com connectionHost/Port.</li>
          <li>Cliente reservou a sessao e abriu o Moonlight.</li>
          <li>Cliente conectou usando IP/porta informados.</li>
        </ul>
      </div>

      <div className={styles.section}>
        <h3>Por onde comecar</h3>
        <ol className={styles.steps}>
          <li>Se voce e host, leia "Host (Sunshine)".</li>
          <li>Se voce e cliente, leia "Cliente (Moonlight)".</li>
          <li>Se tiver erro de conexao, veja "Rede e portas".</li>
          <li>Se a sessao cair, veja "Falhas e creditos".</li>
        </ol>
      </div>
    </>
  );
}
