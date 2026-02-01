import styles from './Docs.module.css';

export default function Docs() {
  return (
    <section className={styles.container}>
      <h1>Docs</h1>
      <p>Documentacao rapida do OpenDesk Desktop (MVP).</p>
      <div className={styles.card}>
        <h3>Primeiros passos</h3>
        <ul>
          <li>Escolha o modo Cliente ou Host na Home.</li>
          <li>Use o header para entrar/criar conta.</li>
          <li>Troque o modo a qualquer momento em Configuracoes.</li>
        </ul>
      </div>
    </section>
  );
}
