import styles from '../docs.module.css';

export default function DocsFalhasPage() {
  return (
    <>
      <div className={styles.section}>
        <h1>Falhas, reconexao e creditos</h1>
        <p>
          Quando a sessao cai, o sistema tenta encerrar corretamente e aplicar
          creditos conforme a politica do MVP.
        </p>
      </div>

      <div className={styles.section}>
        <span className={styles.badge}>O que pode acontecer</span>
        <ul className={styles.checklist}>
          <li>Se o host cair, a sessao pode ser encerrada como FAILED.</li>
          <li>Se o cliente sair, a sessao pode ser encerrada normalmente.</li>
          <li>O saldo pode receber credito proporcional em falhas do host.</li>
        </ul>
      </div>

      <div className={styles.section}>
        <h3>Como reconectar</h3>
        <ol className={styles.steps}>
          <li>Verifique o status da sessao no OpenDesk.</li>
          <li>Se estiver ACTIVE, tente conectar novamente pelo Moonlight.</li>
          <li>Se estiver FAILED, abra outra reserva.</li>
        </ol>
      </div>

      <div className={styles.section}>
        <h3>Dicas</h3>
        <ul className={styles.checklist}>
          <li>Hosts devem manter o Sunshine aberto durante toda a sessao.</li>
          <li>Clientes devem evitar trocar de rede no meio da sessao.</li>
        </ul>
      </div>
    </>
  );
}
