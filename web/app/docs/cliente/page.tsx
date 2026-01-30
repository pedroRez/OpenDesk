import Link from 'next/link';

import styles from '../docs.module.css';

export default function DocsClientePage() {
  return (
    <>
      <div className={styles.section}>
        <h1>Cliente: conectar com Moonlight</h1>
        <p>
          Use o Moonlight para acessar o PC reservado. O OpenDesk nao faz o
          streaming; ele organiza a reserva e informa os dados de conexao.
        </p>
      </div>

      <div className={styles.section}>
        <span className={styles.badge}>Antes de comecar</span>
        <ul className={styles.checklist}>
          <li>Ter uma sessao ativa no OpenDesk.</li>
          <li>Ter o Moonlight instalado no dispositivo do cliente.</li>
          <li>Ter o connectionHost e connectionPort do PC.</li>
        </ul>
      </div>

      <div className={styles.section}>
        <h3>Passo a passo</h3>
        <ol className={styles.steps}>
          <li>Abra o OpenDesk e entre na pagina da sessao.</li>
          <li>Copie o connectionHost e a connectionPort.</li>
          <li>Abra o Moonlight e adicione um novo host com o IP/DNS.</li>
          <li>Finalize o pareamento (se o host pedir PIN).</li>
          <li>Inicie a conexao no Moonlight.</li>
        </ol>
      </div>

      <div className={styles.section}>
        <h3>Dicas rapidas</h3>
        <ul className={styles.checklist}>
          <li>Se o host estiver OFFLINE, aguarde ou contate o host.</li>
          <li>Se a conexao falhar, veja <Link href="/docs/rede">Rede e portas</Link>.</li>
        </ul>
      </div>
    </>
  );
}
