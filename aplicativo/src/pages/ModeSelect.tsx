import { useNavigate } from 'react-router-dom';

import { useMode, type AppMode } from '../lib/mode';

import styles from './ModeSelect.module.css';

export default function ModeSelect() {
  const { setMode } = useMode();
  const navigate = useNavigate();

  const handleSelect = (mode: AppMode) => {
    setMode(mode);
    navigate(mode === 'CLIENT' ? '/client/marketplace' : '/host/dashboard');
  };

  return (
    <section className={styles.container}>
      <div className={styles.hero}>
        <h1>Bem-vindo ao OpenDesk Desktop</h1>
        <p>Escolha como voce quer usar o app agora. Voce pode trocar depois em Configuracoes.</p>
      </div>
      <div className={styles.cards}>
        <button type="button" className={styles.card} onClick={() => handleSelect('CLIENT')}>
          <span className={styles.cardTitle}>Quero Conectar (Cliente)</span>
          <span className={styles.cardText}>Explorar PCs online, reservar tempo e iniciar sessoes.</span>
          <span className={styles.cardCta}>Entrar no Marketplace</span>
        </button>
        <button type="button" className={styles.card} onClick={() => handleSelect('HOST')}>
          <span className={styles.cardTitle}>Quero Ser Host (Disponibilizar PC)</span>
          <span className={styles.cardText}>Cadastrar seus PCs, controlar disponibilidade e ficar online.</span>
          <span className={styles.cardCta}>Abrir Painel do Host</span>
        </button>
      </div>
    </section>
  );
}
