import { useState } from 'react';

import { useToast } from '../components/Toast';
import { useMode, type AppMode } from '../lib/mode';
import { useAuth } from '../lib/auth';
import { apiBaseUrl } from '../lib/api';
import { markLocalPcOffline } from '../lib/localPc';
import { getSunshinePath, setSunshinePath } from '../lib/sunshineSettings';
import { getMoonlightPath, setMoonlightPath } from '../lib/moonlightSettings';
import { detectSunshinePath } from '../lib/sunshineController';
import { detectMoonlightPath } from '../lib/moonlightLauncher';
import { normalizeWindowsPath, pathExists } from '../lib/pathUtils';
import { open } from '@tauri-apps/plugin-dialog';

import styles from './Settings.module.css';

export default function Settings() {
  const { mode, setMode } = useMode();
  const { user } = useAuth();
  const [message, setMessage] = useState('');
  const toast = useToast();
  const [isSwitching, setIsSwitching] = useState(false);
  const [sunshinePath, setSunshinePathValue] = useState(() => getSunshinePath() ?? '');
  const [moonlightPath, setMoonlightPathValue] = useState(() => getMoonlightPath() ?? '');
  const [sunshineStatus, setSunshineStatus] = useState('');
  const [moonlightStatus, setMoonlightStatus] = useState('');

  const handleModeChange = async (nextMode: AppMode) => {
    if (isSwitching) return;
    setIsSwitching(true);
    if (nextMode === 'CLIENT') {
      try {
        const changed = await markLocalPcOffline();
        if (changed) {
          toast.show('Este PC foi colocado OFFLINE porque o modo CLIENTE esta ativo nesta maquina.', 'info');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Falha ao atualizar o PC local.';
        toast.show(errorMessage, 'error');
      }
    }
    setMode(nextMode);
    setMessage(`Modo atualizado para ${nextMode === 'CLIENT' ? 'Cliente' : 'Host'}.`);
    setIsSwitching(false);
  };

  return (
    <section className={styles.container}>
      <h1>Configuracoes</h1>

      <div className={styles.card}>
        <h3>Modo de uso</h3>
        <p>Escolha como este app deve iniciar por padrao.</p>
        <div className={styles.modeButtons}>
          <button
            type="button"
            onClick={() => handleModeChange('CLIENT')}
            className={mode === 'CLIENT' ? styles.active : ''}
            disabled={isSwitching}
          >
            Cliente
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('HOST')}
            className={mode === 'HOST' ? styles.active : ''}
            disabled={isSwitching}
          >
            Host
          </button>
        </div>
      </div>

      <div className={styles.card}>
        <h3>Conta</h3>
        {user ? (
          <p>
            Logado como <strong>{user.displayName ?? user.username}</strong>
          </p>
        ) : (
          <p>Nenhum usuario logado.</p>
        )}
      </div>

      <div className={styles.card}>
        <h3>API</h3>
        <p>Endpoint atual: {apiBaseUrl}</p>
      </div>

      {mode === 'HOST' && (
        <div className={styles.card}>
          <h3>Streaming (Sunshine)</h3>
          <p>Defina o caminho do executavel para iniciar o Sunshine automaticamente no modo Host.</p>
          <label className={styles.field}>
            Caminho do Sunshine
            <input
              value={sunshinePath}
              onChange={(event) => {
                setSunshinePathValue(event.target.value);
                setSunshineStatus('');
              }}
              onBlur={() => setSunshinePath(sunshinePath)}
              placeholder="C:\\Program Files\\Sunshine\\sunshine.exe"
            />
          </label>
          <div className={styles.pathActions}>
            <button
              type="button"
              onClick={async () => {
                try {
                  const selected = await open({
                    multiple: false,
                    filters: [{ name: 'Executavel', extensions: ['exe'] }],
                    defaultPath: 'sunshine.exe',
                  });
                  if (typeof selected === 'string' && selected) {
                    const normalized = normalizeWindowsPath(selected);
                    setSunshinePathValue(normalized);
                    setSunshinePath(normalized);
                    console.log('[PATH] selected sunshinePath=', normalized);
                    setSunshineStatus('Sunshine selecionado.');
                  }
                } catch (error) {
                  console.warn('[PATH] sunshine picker fail', error);
                  setSunshineStatus('Selecao disponivel apenas no app desktop.');
                }
              }}
            >
              Procurar...
            </button>
            <button
              type="button"
              onClick={async () => {
                const detected = await detectSunshinePath();
                if (detected) {
                  setSunshinePathValue(detected);
                  setSunshinePath(detected);
                  console.log('[PATH] autodetect sunshine ok', { path: detected });
                  setSunshineStatus('Sunshine detectado com sucesso.');
                } else {
                  console.log('[PATH] autodetect sunshine fail');
                  setSunshineStatus('Nao encontramos o Sunshine nas pastas padrao.');
                }
              }}
            >
              Localizar automaticamente
            </button>
            <button
              type="button"
              className={styles.ghostButton}
              onClick={async () => {
                const normalized = normalizeWindowsPath(sunshinePath);
                if (normalized) {
                  const exists = await pathExists(normalized);
                  if (exists) {
                    console.log('[PATH] verify sunshine ok', { path: normalized });
                    setSunshineStatus('Detectado OK');
                    setSunshinePathValue(normalized);
                    setSunshinePath(normalized);
                    return;
                  }
                  console.log('[PATH] verify sunshine fail', { path: normalized });
                  setSunshineStatus('Nao encontrado');
                }
                const fallback = await detectSunshinePath();
                if (fallback) {
                  setSunshinePathValue(fallback);
                  setSunshinePath(fallback);
                  console.log('[PATH] autodetect sunshine ok', { path: fallback });
                  setSunshineStatus('Encontrado automaticamente');
                } else {
                  console.log('[PATH] autodetect sunshine fail');
                  setSunshineStatus('Nao encontrado. Use "Procurar...".');
                }
              }}
            >
              Verificar
            </button>
          </div>
          {sunshineStatus && <p className={styles.helper}>{sunshineStatus}</p>}
          <p className={styles.helper}>Se vazio, tentamos caminhos padrao do Windows.</p>
        </div>
      )}

      {mode === 'CLIENT' && (
        <div className={styles.card}>
          <h3>Streaming (Moonlight)</h3>
          <p>Defina o caminho do executavel para abrir o Moonlight automaticamente no modo Cliente.</p>
          <label className={styles.field}>
            Caminho do Moonlight
            <input
              value={moonlightPath}
              onChange={(event) => {
                setMoonlightPathValue(event.target.value);
                setMoonlightStatus('');
              }}
              onBlur={() => setMoonlightPath(moonlightPath)}
              placeholder="C:\\Program Files\\Moonlight Game Streaming\\Moonlight.exe"
            />
          </label>
          <div className={styles.pathActions}>
            <button
              type="button"
              onClick={async () => {
                try {
                  const selected = await open({
                    multiple: false,
                    filters: [{ name: 'Executavel', extensions: ['exe'] }],
                    defaultPath: 'Moonlight.exe',
                  });
                  if (typeof selected === 'string' && selected) {
                    const normalized = normalizeWindowsPath(selected);
                    setMoonlightPathValue(normalized);
                    setMoonlightPath(normalized);
                    console.log('[PATH] selected moonlightPath=', normalized);
                    setMoonlightStatus('Moonlight selecionado.');
                  }
                } catch (error) {
                  console.warn('[PATH] moonlight picker fail', error);
                  setMoonlightStatus('Selecao disponivel apenas no app desktop.');
                }
              }}
            >
              Procurar...
            </button>
            <button
              type="button"
              onClick={async () => {
                const detected = await detectMoonlightPath();
                if (detected) {
                  setMoonlightPathValue(detected);
                  setMoonlightPath(detected);
                  console.log('[PATH] autodetect moonlight ok', { path: detected });
                  setMoonlightStatus('Moonlight detectado com sucesso.');
                } else {
                  console.log('[PATH] autodetect moonlight fail');
                  setMoonlightStatus('Nao encontramos o Moonlight nas pastas padrao.');
                }
              }}
            >
              Localizar automaticamente
            </button>
            <button
              type="button"
              className={styles.ghostButton}
              onClick={async () => {
                const normalized = normalizeWindowsPath(moonlightPath);
                if (normalized) {
                  const exists = await pathExists(normalized);
                  if (exists) {
                    console.log('[PATH] verify moonlight ok', { path: normalized });
                    setMoonlightStatus('Detectado OK');
                    setMoonlightPathValue(normalized);
                    setMoonlightPath(normalized);
                    return;
                  }
                  console.log('[PATH] verify moonlight fail', { path: normalized });
                  setMoonlightStatus('Nao encontrado');
                }
                const fallback = await detectMoonlightPath();
                if (fallback) {
                  setMoonlightPathValue(fallback);
                  setMoonlightPath(fallback);
                  console.log('[PATH] autodetect moonlight ok', { path: fallback });
                  setMoonlightStatus('Encontrado automaticamente');
                } else {
                  console.log('[PATH] autodetect moonlight fail');
                  setMoonlightStatus('Nao encontrado. Use "Procurar...".');
                }
              }}
            >
              Verificar
            </button>
          </div>
          {moonlightStatus && <p className={styles.helper}>{moonlightStatus}</p>}
          <p className={styles.helper}>Se vazio, tentamos caminhos padrao do Windows.</p>
        </div>
      )}

      {message && <p className={styles.message}>{message}</p>}
    </section>
  );
}
