import styles from '../docs.module.css';

export default function DocsRedePage() {
  return (
    <>
      <div className={styles.section}>
        <h1>Rede, portas e firewall</h1>
        <p>
          Problemas de conexao geralmente estao ligados a portas bloqueadas,
          NAT ou firewall. Use este guia para diagnosticar.
        </p>
      </div>

      <div className={styles.section}>
        <span className={styles.badge}>Portas comuns</span>
        <ul className={styles.checklist}>
          <li>47990 (padrao) e 47989 (alternativa) para streaming.</li>
          <li>Se mudou a porta, atualize no painel do host.</li>
        </ul>
      </div>

      <div className={styles.section}>
        <h3>Checklist de rede</h3>
        <ol className={styles.steps}>
          <li>Confirme que o host esta ONLINE no painel.</li>
          <li>Teste a conexao local (cliente e host na mesma rede).</li>
          <li>Se for acesso externo, configure NAT/port-forward.</li>
          <li>Libere a porta no firewall do host.</li>
          <li>Reinicie Sunshine e tente novamente.</li>
        </ol>
      </div>

      <div className={styles.section}>
        <h3>Mensagens comuns</h3>
        <ul className={styles.checklist}>
          <li>"Host offline" indica que o Sunshine nao respondeu.</li>
          <li>"Nao foi possivel conectar" geralmente e porta fechada.</li>
        </ul>
      </div>
    </>
  );
}
