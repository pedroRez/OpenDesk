import type { FormEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

import { useToast } from '../../components/Toast';
import { request } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  getLocalMachineId as getStoredMachineId,
  getHostConnection,
  getLocalPcId,
  getPrimaryPcId,
  setHostConnection,
  setLocalMachineId,
  setLocalPcId,
  setPrimaryPcId,
} from '../../lib/hostState';
import { cancelHardwareProfile, getHardwareProfile, getLocalMachineId, type HardwareProfile } from '../../lib/hardwareProfile';
import { DEFAULT_CONNECT_HINT, detectHostIp, resolveConnectAddress } from '../../lib/networkAddress';
import { detectSunshinePath, ensureSunshineRunning } from '../../lib/sunshineController';
import { getSunshinePath, setSunshinePath } from '../../lib/sunshineSettings';
import { normalizeWindowsPath, pathExists } from '../../lib/pathUtils';
import { open } from '@tauri-apps/plugin-dialog';

import styles from './HostDashboard.module.css';

type PC = {
  id: string;
  hostId: string;
  localPcId?: string | null;
  name: string;
  level: string;
  status: 'ONLINE' | 'OFFLINE' | 'BUSY';
  pricePerHour: number;
  connectionHost?: string | null;
  connectionPort?: number | null;
  connectionNotes?: string | null;
  cpu?: string;
  ramGb?: number;
  gpu?: string;
  vramGb?: number;
  storageType?: string;
  internetUploadMbps?: number;
};

type AutoForm = {
  nickname: string;
};

type PCInput = {
  name: string;
  level: string;
  cpu: string;
  ramGb: number;
  gpu: string;
  vramGb: number;
  storageType: string;
  internetUploadMbps: number;
  pricePerHour: number;
  connectionHost: string;
  connectionPort: number;
  connectionNotes: string;
};

const createDefaultForm = (): PCInput => ({
  name: '',
  level: 'B',
  cpu: '',
  ramGb: 16,
  gpu: '',
  vramGb: 8,
  storageType: 'SSD',
  internetUploadMbps: 200,
  pricePerHour: 10,
  connectionHost: '',
  connectionPort: 47990,
  connectionNotes: '',
});

export default function HostDashboard() {
  const { user, updateUser } = useAuth();
  const toast = useToast();
  const [pcs, setPcs] = useState<PC[]>([]);
  const [isLoadingPcs, setIsLoadingPcs] = useState(false);
  const [isCreatingHost, setIsCreatingHost] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingPcId, setEditingPcId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    connectionHost: '',
    connectionPort: 47990,
    connectionNotes: '',
  });
  const [form, setForm] = useState<PCInput>(createDefaultForm);
  const [isPublishingNetwork, setIsPublishingNetwork] = useState(false);
  const [operationMessage, setOperationMessage] = useState('');
  const [showSunshineHelp, setShowSunshineHelp] = useState(false);
  const [sunshineHelpStatus, setSunshineHelpStatus] = useState('');
  const [disconnectingPcId, setDisconnectingPcId] = useState<string | null>(null);
  const [localMachineId, setLocalMachineIdState] = useState<string | null>(getStoredMachineId());
  const [localPcRecord, setLocalPcRecord] = useState<PC | null>(null);
  const [autoModalOpen, setAutoModalOpen] = useState(false);
  const [autoStep, setAutoStep] = useState<'idle' | 'detecting' | 'review' | 'creating'>('idle');
  const [autoStatus, setAutoStatus] = useState('');
  const [autoRequestId, setAutoRequestId] = useState<string | null>(null);
  const [hardwareProfile, setHardwareProfile] = useState<HardwareProfile | null>(null);
  const [autoForm, setAutoForm] = useState<AutoForm>({
    nickname: '',
  });
  const [autoError, setAutoError] = useState('');
  const [autoErrorDetails, setAutoErrorDetails] = useState('');
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [onlineModalPc, setOnlineModalPc] = useState<PC | null>(null);
  const [onlineStep, setOnlineStep] = useState<
    'idle' | 'checking' | 'needs_sunshine' | 'needs_connection' | 'publishing' | 'activating' | 'done' | 'error'
  >('idle');
  const [onlineStatus, setOnlineStatus] = useState('');
  const [onlineError, setOnlineError] = useState('');
  const [onlineConnection, setOnlineConnection] = useState({ host: '', port: 47990 });
  const [onlineBusy, setOnlineBusy] = useState(false);
  const manualEnabled = false;

  const hostProfileId = user?.hostProfileId ?? null;
  const isHost = useMemo(() => Boolean(hostProfileId), [hostProfileId]);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastHeartbeatLogRef = useRef<number>(0);
  const autoAbortRef = useRef<AbortController | null>(null);
  const onlineAbortRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  const heartbeatPcId = useMemo(() => {
    const localId = getLocalPcId();
    if (localId) {
      const localPc = pcs.find((pc) => pc.id === localId);
      if (localPc?.status === 'ONLINE') {
        return localPc.id;
      }
    }
    const primaryId = getPrimaryPcId();
    if (primaryId) {
      const primaryPc = pcs.find((pc) => pc.id === primaryId);
      if (primaryPc?.status === 'ONLINE') {
        return primaryPc.id;
      }
    }
    const anyOnline = pcs.find((pc) => pc.status === 'ONLINE');
    return anyOnline?.id ?? null;
  }, [pcs]);

  useEffect(() => {
    if (!hostProfileId) return;
    if (localMachineId) return;
    getLocalMachineId()
      .then((id) => {
        if (id) {
          setLocalMachineIdState(id);
          setLocalMachineId(id);
        }
      })
      .catch((error) => console.warn('[HARDWARE] local pc id fail', error));
  }, [hostProfileId, localMachineId]);

  useEffect(() => {
    if (!localMachineId) {
      setLocalPcRecord(null);
      return;
    }
    const found = pcs.find((pc) => pc.localPcId === localMachineId) ?? null;
    setLocalPcRecord(found);
    if (found) {
      setLocalPcId(found.id);
      setPrimaryPcId(found.id);
      setTimeout(() => {
        const el = document.getElementById(`pc-card-${found.id}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 200);
    }
  }, [pcs, localMachineId]);

  useEffect(() => {
    if (!autoRequestId) return;
    let isActive = true;
    const setup = async () => {
      const unlisten = await listen<{
        requestId: string;
        status: string;
      }>('hardware-progress', (event) => {
        if (!isActive) return;
        if (event.payload?.requestId === autoRequestId) {
          setAutoStatus(event.payload.status);
        }
      });
      return unlisten;
    };
    let cleanup: (() => void) | null = null;
    setup().then((unlisten) => {
      cleanup = unlisten;
    });
    return () => {
      isActive = false;
      if (cleanup) cleanup();
    };
  }, [autoRequestId]);

  useEffect(() => {
    if (!hostProfileId) return;
    setIsLoadingPcs(true);
    request<PC[]>(`/hosts/${hostProfileId}/pcs`)
      .then((data) => {
        setPcs(data);
        if (data.length > 0) {
          setPrimaryPcId(data[0].id);
        }
      })
      .catch((error) => {
        setPcs([]);
        const message = error instanceof Error ? error.message : 'Erro ao carregar PCs';
        toast.show(message, 'error');
      })
      .finally(() => setIsLoadingPcs(false));
  }, [hostProfileId, toast]);

  useEffect(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (!hostProfileId || !user?.id || !heartbeatPcId) {
      return;
    }

    const hostId = hostProfileId;
    const pcId = heartbeatPcId;
    const intervalMs = 10000;
    console.log('[HB][DESKTOP] start', { hostId, pcId, intervalMs });

    const sendHeartbeat = async () => {
      const timestamp = new Date().toISOString();
      try {
        await request(`/hosts/${hostId}/heartbeat`, {
          method: 'POST',
          body: JSON.stringify({ pcId, timestamp }),
        });
        const logLevel = (import.meta.env.VITE_LOG_HEARTBEAT ?? 'sampled').toLowerCase();
        const isDebug = logLevel === 'debug' || logLevel === 'full' || logLevel === 'true';
        if (logLevel !== 'off' && logLevel !== 'false') {
          if (isDebug) {
            console.log('[HB][DESKTOP] alive', { hostId, pcId, timestamp });
          } else {
            const sampleSeconds = Number(import.meta.env.VITE_HEARTBEAT_LOG_SAMPLE_SECONDS ?? 60);
            const nowMs = Date.now();
            if (nowMs - lastHeartbeatLogRef.current >= sampleSeconds * 1000) {
              lastHeartbeatLogRef.current = nowMs;
              console.log('[HB][DESKTOP] alive', { hostId, pcId, timestamp });
            }
          }
        }
      } catch (error) {
        console.error('[HB][DESKTOP] fail status', {
          hostId,
          pcId,
          timestamp,
          error: error instanceof Error ? error.message : error,
        });
      }
    };

    sendHeartbeat();
    heartbeatRef.current = setInterval(sendHeartbeat, intervalMs);

    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [hostProfileId, user?.id, heartbeatPcId]);

  const handleCreateHostProfile = async () => {
    if (!user) return;
    setIsCreatingHost(true);
    try {
      const data = await request<{ hostProfileId?: string; hostProfile?: { id: string } }>('/host/profile', {
        method: 'POST',
        body: JSON.stringify({ displayName: user.displayName ?? user.username }),
      });
      const hostId = data.hostProfileId ?? data.hostProfile?.id ?? null;
      updateUser({ role: 'HOST', hostProfileId: hostId });
      toast.show('Perfil de host criado com sucesso!', 'success');
    } catch (error) {
      toast.show(error instanceof Error ? error.message : 'Erro ao criar perfil.', 'error');
    } finally {
      setIsCreatingHost(false);
    }
  };

  const handleCreatePC = async (event: FormEvent) => {
    event.preventDefault();

    setOperationMessage('Criando PC...');
    try {
      const payload = {
        ...form,
        connectionHost: form.connectionHost.trim() || undefined,
        connectionNotes: form.connectionNotes.trim() || undefined,
        connectionPort: Number(form.connectionPort) || undefined,
        ramGb: Number(form.ramGb),
        vramGb: Number(form.vramGb),
        internetUploadMbps: Number(form.internetUploadMbps),
        pricePerHour: Number(form.pricePerHour),
        localPcId: localMachineId ?? undefined,
      };
      const created = await request<PC>('/pcs', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setPcs((prev) => [created, ...prev]);
      setPrimaryPcId(created.id);
      setLocalPcId(created.id);
      setLocalPcRecord(created);
      toast.show('PC cadastrado com sucesso!', 'success');
      setForm(createDefaultForm());
      setIsFormOpen(false);
      if (created.status === 'ONLINE') {
        await publishNetwork(created.id);
      }
    } catch (error) {
      toast.show(error instanceof Error ? error.message : 'Erro ao cadastrar PC', 'error');
    } finally {
      setOperationMessage('');
    }
  };

  const handleToggleStatus = async (pc: PC) => {
    if (pc.status === 'BUSY') {
      toast.show('PC ocupado. Nao e possivel ficar offline agora.', 'info');
      return;
    }
    if (pc.status === 'OFFLINE') {
      await startOnlineFlow(pc);
      return;
    }
    const nextStatus = 'OFFLINE';
    setOperationMessage('Colocando PC offline...');
    setPcs((prev) => prev.map((item) => (item.id === pc.id ? { ...item, status: nextStatus } : item)));
    try {
      const data = await request<{ pc: PC }>(`/pcs/${pc.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      setPcs((prev) => prev.map((item) => (item.id === pc.id ? data.pc : item)));
      toast.show('PC ficou offline', 'success');
    } catch (error) {
      setPcs((prev) => prev.map((item) => (item.id === pc.id ? pc : item)));
      toast.show(error instanceof Error ? error.message : 'Falha ao atualizar status', 'error');
    } finally {
      setOperationMessage('');
    }
  };

  const resetAutoFlow = () => {
    setAutoModalOpen(false);
    setAutoStep('idle');
    setAutoStatus('');
    setAutoRequestId(null);
    setHardwareProfile(null);
    setAutoError('');
    setAutoErrorDetails('');
    setShowErrorDetails(false);
  };

  const handleAutoDetect = async () => {
    if (!localMachineId) {
      toast.show('Nao foi possivel identificar este PC.', 'error');
      return;
    }
    if (autoStep === 'detecting') return;
    autoAbortRef.current?.abort();
    autoAbortRef.current = new AbortController();
    const { signal } = autoAbortRef.current;
    const requestId = crypto.randomUUID();
    console.log('[HW] start detect', { requestId });
    setAutoRequestId(requestId);
    setAutoStatus('Detectando hardware...');
    setAutoModalOpen(true);
    setAutoStep('detecting');
    try {
      const profile = await getHardwareProfile(requestId);
      if (signal.aborted) {
        console.log('[HW] canceled', { requestId });
        resetAutoFlow();
        return;
      }
      console.log('[HW] detected', {
        cpu: profile.cpuName,
        ram: profile.ramGb,
        gpu: profile.gpuName,
        storage: profile.storageSummary,
      });
      setHardwareProfile(profile);
      setAutoForm({
        nickname: '',
      });
      setAutoError('');
      setAutoErrorDetails('');
      setShowErrorDetails(false);
      setAutoStep('review');
      setAutoStatus('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      if (message.includes('cancelled')) {
        console.log('[HW] canceled', { requestId });
        setAutoStatus('Deteccao cancelada.');
      } else {
        console.warn('[HW] failed', { error: message });
        toast.show(message || 'Falha ao detectar hardware', 'error');
      }
      resetAutoFlow();
    } finally {
      setAutoRequestId(null);
    }
  };

  const handleCancelAuto = async () => {
    autoAbortRef.current?.abort();
    if (autoRequestId) {
      await cancelHardwareProfile(autoRequestId);
    }
    console.log('[HW] canceled');
    resetAutoFlow();
  };

  const handleConfirmAuto = async () => {
    if (!hardwareProfile || !localMachineId) return;
    if (autoStep === 'creating') return;
    setAutoStep('creating');
    setAutoError('');
    setAutoErrorDetails('');
    setShowErrorDetails(false);
    console.log('[PC_CREATE] start', { localPcId: localMachineId });
    try {
      const payload = {
        localPcId: localMachineId,
        nickname: autoForm.nickname.trim() || undefined,
        hardwareProfile,
      };
      const created = await request<PC>('/pcs', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      console.log('[PC_CREATE] success', { pcId: created.id });
      setPcs((prev) => {
        const existingIndex = prev.findIndex((pc) => pc.id === created.id);
        if (existingIndex >= 0) {
          const next = [...prev];
          next[existingIndex] = created;
          return next;
        }
        return [created, ...prev];
      });
      setLocalPcId(created.id);
      setPrimaryPcId(created.id);
      setLocalPcRecord(created);
      toast.show(
        pcs.some((pc) => pc.id === created.id)
          ? 'PC ja estava cadastrado.'
          : 'PC cadastrado com sucesso!',
        'success',
      );
      resetAutoFlow();
      setTimeout(() => {
        const el = document.getElementById(`pc-card-${created.id}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro desconhecido';
      console.warn('[PC_CREATE] fail', { error: message });
      setAutoError('Nao foi possivel cadastrar este PC. Tente novamente.');
      setAutoErrorDetails(message);
      toast.show('Nao foi possivel cadastrar este PC. Tente novamente.', 'error');
      setAutoStep('review');
    }
  };

  const handleFinishPreview = () => {
    resetAutoFlow();
  };

  const handleDisconnect = async (pc: PC) => {
    if (disconnectingPcId) return;
    const confirmed = window.confirm('Desconectar o cliente e liberar este PC?');
    if (!confirmed) return;
    setDisconnectingPcId(pc.id);
    try {
      const response = await request<{ pc: PC | null; sessionEnded: boolean }>(
        `/host/pcs/${pc.id}/disconnect`,
        {
          method: 'POST',
        },
      );
      if (response.pc) {
        setPcs((prev) => prev.map((item) => (item.id === pc.id ? response.pc! : item)));
      }
      toast.show(
        response.sessionEnded
          ? 'Sessao encerrada e PC liberado.'
          : 'PC liberado.',
        'success',
      );
    } catch (error) {
      toast.show(error instanceof Error ? error.message : 'Falha ao desconectar.', 'error');
    } finally {
      setDisconnectingPcId(null);
    }
  };

  const handleSunshineBrowse = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Executavel', extensions: ['exe'] }],
        defaultPath: 'sunshine.exe',
      });
      if (typeof selected === 'string' && selected) {
        const normalized = normalizeWindowsPath(selected);
        setSunshinePath(normalized);
        console.log('[PATH] selected sunshinePath=', normalized);
        setSunshineHelpStatus('Sunshine selecionado.');
      }
    } catch (error) {
      console.warn('[PATH] sunshine picker fail', error);
      setSunshineHelpStatus('Selecao disponivel apenas no app desktop.');
    }
  };

  const handleSunshineVerify = async () => {
    const current = getSunshinePath();
    if (current) {
      const exists = await pathExists(current);
      if (exists) {
        console.log('[PATH] verify sunshine ok', { path: current });
        setSunshineHelpStatus('Detectado OK');
        return;
      }
      console.log('[PATH] verify sunshine fail', { path: current });
      setSunshineHelpStatus('Nao encontrado');
    }
    const fallback = await detectSunshinePath();
    if (fallback) {
      console.log('[PATH] autodetect sunshine ok', { path: fallback });
      setSunshineHelpStatus('Encontrado automaticamente');
    } else {
      console.log('[PATH] autodetect sunshine fail');
      setSunshineHelpStatus('Nao encontrado. Use "Procurar...".');
    }
  };

  const handleSunshineAutoDetect = async () => {
    const detected = await detectSunshinePath();
    if (detected) {
      console.log('[PATH] autodetect sunshine ok', { path: detected });
      setSunshineHelpStatus('Encontrado automaticamente');
    } else {
      console.log('[PATH] autodetect sunshine fail');
      setSunshineHelpStatus('Nao encontramos o Sunshine nas pastas padrao.');
    }
  };

  const publishNetwork = async (pcId: string) => {
    if (isPublishingNetwork) return;
    setIsPublishingNetwork(true);
    setOperationMessage('Publicando conexao...');
    try {
      const running = await ensureSunshineRunning();
      if (!running) {
        console.error('[NET][HOST] sunshine not running; abort publish', { pcId });
        return;
      }
      let connectAddress: string;
      try {
        connectAddress = await resolveConnectAddress();
      } catch (error) {
        console.error('[NET][HOST] failed to resolve connectAddress', {
          pcId,
          error: error instanceof Error ? error.message : error,
        });
        toast.show('Nao foi possivel detectar o IP do host. Salve a conexao manualmente.', 'error');
        return;
      }
      console.log('[NET][HOST] publishing connectAddress', { pcId, address: connectAddress });
      const response = await request(`/pcs/${pcId}/network`, {
        method: 'POST',
        body: JSON.stringify({
          networkProvider: 'DIRECT',
          connectAddress,
          connectHint: DEFAULT_CONNECT_HINT,
        }),
      });
      console.log('[NET][HOST] publish ok', { pcId, connectHint: DEFAULT_CONNECT_HINT, response });
    } catch (error) {
      console.error('[NET][HOST] publish fail', {
        pcId,
        error: error instanceof Error ? error.message : error,
      });
    } finally {
      setIsPublishingNetwork(false);
      setOperationMessage('');
    }
  };

  const publishConnection = async (pcId: string, host: string, port: number) => {
    try {
      const response = await request<{ pc: PC }>(`/pcs/${pcId}/network`, {
        method: 'POST',
        body: JSON.stringify({
          networkProvider: 'DIRECT',
          connectionHost: host,
          connectionPort: port,
          connectHint: DEFAULT_CONNECT_HINT,
        }),
      });
      if (response?.pc) {
        setPcs((prev) => prev.map((item) => (item.id === pcId ? response.pc : item)));
      }
      setHostConnection(host, port);
      return response?.pc ?? null;
    } catch (error) {
      console.error('[NET][HOST] publish fail', {
        pcId,
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  };

  const closeOnlineModal = () => {
    setOnlineModalPc(null);
    setOnlineStep('idle');
    setOnlineStatus('');
    setOnlineError('');
    setOnlineBusy(false);
  };

  const startOnlineFlow = async (pc: PC, override?: { host: string; port: number }) => {
    onlineAbortRef.current.cancelled = false;
    const stored = getHostConnection();
    const host =
      override?.host ?? onlineConnection.host ?? pc.connectionHost ?? stored?.host ?? '';
    const port =
      override?.port ?? onlineConnection.port ?? pc.connectionPort ?? stored?.port ?? 47990;
    setOnlineConnection({ host, port });
    setOnlineModalPc(pc);
    setOnlineError('');
    setOnlineStatus('Verificando Sunshine...');
    setOnlineStep('checking');

    const detected = await detectSunshinePath();
    if (onlineAbortRef.current.cancelled) return;
    if (!detected) {
      setOnlineStep('needs_sunshine');
      setOnlineStatus('Sunshine nao detectado.');
      return;
    }
    const running = await ensureSunshineRunning();
    if (onlineAbortRef.current.cancelled) return;
    if (!running) {
      setOnlineStep('needs_sunshine');
      setOnlineStatus('Sunshine nao detectado.');
      return;
    }

    if (!host) {
      setOnlineStep('needs_connection');
      setOnlineStatus('Informe o host/porta da conexao.');
      return;
    }

    setOnlineStep('publishing');
    setOnlineStatus('Publicando conexao...');
    setOnlineBusy(true);
    const published = await publishConnection(pc.id, host, port);
    if (!published) {
      setOnlineBusy(false);
      setOnlineStep('error');
      setOnlineError('Nao foi possivel publicar a conexao.');
      return;
    }

    setOnlineStep('activating');
    setOnlineStatus('Ativando modo ONLINE...');
    try {
      const data = await request<{ pc: PC }>(`/pcs/${pc.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'ONLINE' }),
      });
      setPcs((prev) => prev.map((item) => (item.id === pc.id ? data.pc : item)));
      console.log('[PC] online', { pcId: pc.id });
      setOnlineStep('done');
      setOnlineStatus('ONLINE ✅');
      setTimeout(() => closeOnlineModal(), 900);
    } catch (error) {
      setOnlineStep('error');
      setOnlineError(error instanceof Error ? error.message : 'Falha ao ficar ONLINE.');
    } finally {
      setOnlineBusy(false);
    }
  };

  const handleOnlineCancel = () => {
    if (onlineBusy) return;
    onlineAbortRef.current.cancelled = true;
    closeOnlineModal();
  };

  const handleOnlineRetry = () => {
    if (!onlineModalPc) return;
    const normalizedPort = Number(onlineConnection.port) || 47990;
    const nextConnection = { host: onlineConnection.host, port: normalizedPort };
    setOnlineConnection(nextConnection);
    if (nextConnection.host) {
      setHostConnection(nextConnection.host, nextConnection.port);
    }
    startOnlineFlow(onlineModalPc, nextConnection);
  };

  const handleAutoFillConnection = async () => {
    const detected = await detectHostIp();
    if (detected) {
      setOnlineConnection((prev) => ({
        host: detected,
        port: Number(prev.port) || 47990,
      }));
      setOnlineStatus(`Detectado automaticamente: ${detected}`);
    } else {
      setOnlineStatus('Nao foi possivel detectar o IP automaticamente.');
    }
  };

  const startEditing = (pc: PC) => {
    setEditingPcId(pc.id);
    setEditForm({
      connectionHost: pc.connectionHost ?? '',
      connectionPort: pc.connectionPort ?? 47990,
      connectionNotes: pc.connectionNotes ?? '',
    });
  };

  const handleSaveConnection = async (pc: PC) => {
    setOperationMessage('Salvando conexao...');
    try {
      const payload = {
        connectionHost: editForm.connectionHost.trim() || undefined,
        connectionPort: Number(editForm.connectionPort) || undefined,
        connectionNotes: editForm.connectionNotes.trim() || undefined,
      };
      const updated = await request<PC>(`/pcs/${pc.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      setPcs((prev) => prev.map((item) => (item.id === pc.id ? updated : item)));
      setEditingPcId(null);
      toast.show('Dados de conexao atualizados.', 'success');

      const resolvedHost = payload.connectionHost ?? updated.connectionHost ?? '';
      const resolvedPort = payload.connectionPort ?? updated.connectionPort ?? 47990;
      if (resolvedHost) {
        try {
          setOperationMessage('Publicando conexao...');
          await publishConnection(pc.id, resolvedHost, resolvedPort);
        } catch (error) {
          console.error('[NET][HOST] publish fail', {
            pcId: pc.id,
            error: error instanceof Error ? error.message : error,
          });
        }
      }
    } catch (error) {
      toast.show(error instanceof Error ? error.message : 'Erro ao atualizar conexao.', 'error');
    } finally {
      setOperationMessage('');
    }
  };

  const handleDeletePc = async (pc: PC) => {
    const confirmed = window.confirm(`Excluir o PC "${pc.name}"? Esta acao nao pode ser desfeita.`);
    if (!confirmed) return;
    try {
      await request(`/pcs/${pc.id}`, { method: 'DELETE' });
      setPcs((prev) => prev.filter((item) => item.id !== pc.id));
      toast.show('PC removido com sucesso.', 'success');
    } catch (error) {
      toast.show(error instanceof Error ? error.message : 'Erro ao remover PC.', 'error');
    }
  };

  const onlineStepIndex =
    onlineStep === 'publishing'
      ? 1
      : onlineStep === 'activating'
        ? 2
        : onlineStep === 'done'
          ? 3
          : 0;

  return (
    <section className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1>Painel do Host</h1>
          <p>Gerencie seus PCs e fique online quando quiser.</p>
        </div>
      </div>

      {!isHost && (
        <div className={styles.cta}>
          <strong>Voce ainda nao e host.</strong>
          <span>Crie seu perfil para cadastrar PCs e ficar online.</span>
          <button type="button" onClick={handleCreateHostProfile} disabled={isCreatingHost}>
            {isCreatingHost ? 'Criando...' : 'Criar perfil host'}
          </button>
        </div>
      )}

      {isHost && (
        <section className={styles.list}>
          {operationMessage && (
            <div className={styles.operationBar}>
              <span className={styles.spinner} />
              <span>{operationMessage}</span>
            </div>
          )}
          <div className={styles.listHeader}>
            <div>
              <h3>Seus PCs</h3>
              <p className={styles.listHint}>Controle disponibilidade e conexao por PC.</p>
            </div>
            {manualEnabled && (
              <button
                type="button"
                onClick={() => setIsFormOpen((prev) => !prev)}
                className={styles.toggleButton}
                aria-expanded={isFormOpen}
                aria-controls="pc-form"
              >
                <span>{isFormOpen ? 'Fechar cadastro' : 'Cadastrar PC'}</span>
                <span className={styles.toggleIcon}>{isFormOpen ? 'v' : '>'}</span>
              </button>
            )}
          </div>

          <div className={styles.localPcPanel}>
            <div>
              <strong>Cadastro rapido deste PC</strong>
              <p className={styles.listHint}>
                Detecte o hardware automaticamente e cadastre este PC com 1 clique.
              </p>
            </div>
            {localPcRecord ? (
              <div className={styles.localPcActions}>
                <span>
                  Este PC ja esta cadastrado como <strong>{localPcRecord.name}</strong>.
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const el = document.getElementById(`pc-card-${localPcRecord.id}`);
                    if (el) {
                      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                  }}
                  className={styles.ghost}
                >
                  Ver no painel
                </button>
              </div>
            ) : (
              <div className={styles.localPcActions}>
                <button
                  type="button"
                  onClick={handleAutoDetect}
                  disabled={!localMachineId || Boolean(operationMessage)}
                >
                  {localMachineId ? 'Cadastrar este PC' : 'Detectando identificador...'}
                </button>
              </div>
            )}
          </div>

          {manualEnabled && isFormOpen && (
            <form onSubmit={handleCreatePC} className={`${styles.form} ${styles.formPanel}`} id="pc-form">
              <h3>Cadastrar PC</h3>
              <div className={styles.grid}>
                <label>
                  Nome do PC
                  <input
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    required
                  />
                </label>
                <label>
                  Nivel
                  <select value={form.level} onChange={(event) => setForm({ ...form, level: event.target.value })}>
                    <option value="A">A</option>
                    <option value="B">B</option>
                    <option value="C">C</option>
                  </select>
                </label>
                <label>
                  CPU
                  <input
                    value={form.cpu}
                    onChange={(event) => setForm({ ...form, cpu: event.target.value })}
                    required
                  />
                </label>
                <label>
                  RAM (GB)
                  <input
                    type="number"
                    value={form.ramGb}
                    onChange={(event) => setForm({ ...form, ramGb: Number(event.target.value) })}
                  />
                </label>
                <label>
                  GPU
                  <input value={form.gpu} onChange={(event) => setForm({ ...form, gpu: event.target.value })} />
                </label>
                <label>
                  VRAM (GB)
                  <input
                    type="number"
                    value={form.vramGb}
                    onChange={(event) => setForm({ ...form, vramGb: Number(event.target.value) })}
                  />
                </label>
                <label>
                  Storage
                  <input
                    value={form.storageType}
                    onChange={(event) => setForm({ ...form, storageType: event.target.value })}
                  />
                </label>
                <label>
                  Upload (Mbps)
                  <input
                    type="number"
                    value={form.internetUploadMbps}
                    onChange={(event) => setForm({ ...form, internetUploadMbps: Number(event.target.value) })}
                  />
                </label>
                <label>
                  Preco por hora
                  <input
                    type="number"
                    value={form.pricePerHour}
                    onChange={(event) => setForm({ ...form, pricePerHour: Number(event.target.value) })}
                  />
                </label>
                <label>
                  Connection Host (IP/DNS)
                  <input
                    value={form.connectionHost}
                    onChange={(event) => setForm({ ...form, connectionHost: event.target.value })}
                    placeholder="192.168.0.10"
                  />
                </label>
                <label>
                  Connection Port
                  <input
                    type="number"
                    value={form.connectionPort}
                    onChange={(event) => setForm({ ...form, connectionPort: Number(event.target.value) })}
                  />
                </label>
                <label>
                  Connection Notes
                  <input
                    value={form.connectionNotes}
                    onChange={(event) => setForm({ ...form, connectionNotes: event.target.value })}
                    placeholder="Use Moonlight, perfil 1080p"
                  />
                </label>
              </div>
              <div className={styles.formActions}>
                <button type="submit" disabled={Boolean(operationMessage)}>
                  Cadastrar PC
                </button>
                <button type="button" onClick={() => setIsFormOpen(false)} className={styles.ghost}>
                  Cancelar
                </button>
              </div>
            </form>
          )}

          {isLoadingPcs && <p>Carregando PCs...</p>}
          {!isLoadingPcs && pcs.length === 0 && (
            <p>{localPcRecord ? 'Este PC ja esta cadastrado.' : 'Nenhum PC cadastrado.'}</p>
          )}
          {showSunshineHelp && (
            <div className={styles.missingPanel}>
              <strong>Sunshine nao detectado.</strong>
              <p>O OpenDesk instalara/configurara automaticamente em producao. Em DEV, informe o caminho.</p>
              <div className={styles.missingActions}>
                <button type="button" onClick={handleSunshineBrowse}>
                  Procurar...
                </button>
                <button type="button" onClick={handleSunshineVerify} className={styles.ghost}>
                  Verificar
                </button>
                <button type="button" onClick={handleSunshineAutoDetect} className={styles.ghost}>
                  Localizar automaticamente
                </button>
              </div>
              {sunshineHelpStatus && <p className={styles.helperText}>{sunshineHelpStatus}</p>}
            </div>
          )}
          {pcs.map((pc) => {
            const statusClass =
              pc.status === 'ONLINE'
                ? styles.statusOnline
                : pc.status === 'OFFLINE'
                  ? styles.statusOffline
                  : styles.statusBusy;

            return (
              <div key={pc.id} id={`pc-card-${pc.id}`} className={styles.pcCard}>
                <div className={styles.pcInfo}>
                  <div className={styles.pcHeader}>
                    <strong>{pc.name}</strong>
                    <span className={`${styles.statusBadge} ${statusClass}`}>{pc.status}</span>
                  </div>
                  <span>
                    Conexao: {pc.connectionHost ?? 'Nao informado'}:{pc.connectionPort ?? 47990}
                  </span>
                  {pc.connectionNotes && <span>Notas: {pc.connectionNotes}</span>}
                </div>
                <div className={styles.pcActions}>
                  <button
                    type="button"
                    onClick={() => handleToggleStatus(pc)}
                    className={pc.status === 'BUSY' ? styles.disabled : ''}
                    disabled={pc.status === 'BUSY' || Boolean(operationMessage)}
                  >
                    {pc.status === 'ONLINE' ? 'Ficar OFFLINE' : 'Ficar ONLINE'}
                  </button>
                  {pc.status === 'BUSY' && (
                    <button
                      type="button"
                      onClick={() => handleDisconnect(pc)}
                      disabled={disconnectingPcId === pc.id}
                      className={disconnectingPcId === pc.id ? styles.disabled : ''}
                    >
                      {disconnectingPcId === pc.id ? 'Desconectando...' : 'Desconectar'}
                    </button>
                  )}
                  <button type="button" onClick={() => startEditing(pc)} disabled={Boolean(operationMessage)}>
                    Editar conexao
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeletePc(pc)}
                    className={styles.dangerButton}
                    disabled={Boolean(operationMessage)}
                  >
                    Excluir PC
                  </button>
                </div>

                {editingPcId === pc.id && (
                  <div className={styles.editPanel}>
                    <label>
                      Connection Host (IP/DNS)
                      <input
                        value={editForm.connectionHost}
                        onChange={(event) => setEditForm({ ...editForm, connectionHost: event.target.value })}
                        placeholder="192.168.0.10"
                      />
                    </label>
                    <label>
                      Connection Port
                      <input
                        type="number"
                        value={editForm.connectionPort}
                        onChange={(event) =>
                          setEditForm({
                            ...editForm,
                            connectionPort: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      Connection Notes
                      <input
                        value={editForm.connectionNotes}
                        onChange={(event) => setEditForm({ ...editForm, connectionNotes: event.target.value })}
                        placeholder="Use Moonlight, perfil 1080p"
                      />
                    </label>
                    <div className={styles.editActions}>
                      <button type="button" onClick={() => handleSaveConnection(pc)} disabled={Boolean(operationMessage)}>
                        Salvar conexao
                      </button>
                      <button type="button" onClick={() => setEditingPcId(null)} className={styles.ghost}>
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {autoModalOpen && (
            <div className={styles.overlay} role="dialog" aria-modal="true">
              <div className={styles.modal}>
                {autoStep === 'detecting' && (
                  <div className={styles.modalBody}>
                    <h3>Detectando hardware...</h3>
                    <div className={styles.modalRow}>
                      <span className={styles.spinner} />
                      <span>{autoStatus || 'Detectando hardware...'}</span>
                    </div>
                    <div className={styles.modalActions}>
                      <button type="button" onClick={handleCancelAuto} className={styles.ghost}>
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
                {autoStep === 'review' && hardwareProfile && (
                  <div className={styles.modalBody}>
                    <h3>Resumo detectado</h3>
                    <div className={styles.summaryBox}>
                      <div><strong>CPU:</strong> {hardwareProfile.cpuName}</div>
                      <div><strong>RAM:</strong> {hardwareProfile.ramGb} GB</div>
                      <div><strong>GPU:</strong> {hardwareProfile.gpuName}</div>
                      <div><strong>Storage:</strong> {hardwareProfile.storageSummary}</div>
                    </div>
                    <label>
                      Apelido do PC
                      <input
                        value={autoForm.nickname}
                        onChange={(event) => setAutoForm({ ...autoForm, nickname: event.target.value })}
                        placeholder="Ex.: PC Sala"
                      />
                    </label>
                    {autoError && (
                      <div className={styles.errorBox}>
                        <p>{autoError}</p>
                        {import.meta.env.DEV && autoErrorDetails && (
                          <button
                            type="button"
                            className={styles.ghost}
                            onClick={() => setShowErrorDetails((prev) => !prev)}
                          >
                            {showErrorDetails ? 'Ocultar detalhes' : 'Ver detalhes'}
                          </button>
                        )}
                        {showErrorDetails && autoErrorDetails && (
                          <pre className={styles.errorDetails}>{autoErrorDetails}</pre>
                        )}
                      </div>
                    )}
                    <div className={styles.modalActions}>
                      <button type="button" onClick={handleConfirmAuto} disabled={autoStep === 'creating'}>
                        Confirmar cadastro
                      </button>
                      <button type="button" onClick={handleFinishPreview} className={styles.ghost}>
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
                {autoStep === 'creating' && (
                  <div className={styles.modalBody}>
                    <h3>Criando PC...</h3>
                    <div className={styles.modalRow}>
                      <span className={styles.spinner} />
                      <span>Finalizando cadastro...</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {onlineModalPc && (
            <div className={styles.overlay} role="dialog" aria-modal="true">
              <div className={styles.modal}>
                <div className={styles.modalBody}>
                  <h3>Ficar ONLINE</h3>
                  <ul className={styles.stepList}>
                    <li
                      className={`${styles.stepItem} ${
                        onlineStepIndex > 0 || onlineStep === 'publishing' || onlineStep === 'activating' || onlineStep === 'done'
                          ? styles.stepDone
                          : styles.stepActive
                      }`}
                    >
                      <span className={styles.stepDot} />
                      Verificando Sunshine
                    </li>
                    <li
                      className={`${styles.stepItem} ${
                        onlineStepIndex > 1 || onlineStep === 'activating' || onlineStep === 'done'
                          ? styles.stepDone
                          : onlineStepIndex === 1
                            ? styles.stepActive
                            : styles.stepPending
                      }`}
                    >
                      <span className={styles.stepDot} />
                      Publicando conexao
                    </li>
                    <li
                      className={`${styles.stepItem} ${
                        onlineStepIndex > 2 || onlineStep === 'done'
                          ? styles.stepDone
                          : onlineStepIndex === 2
                            ? styles.stepActive
                            : styles.stepPending
                      }`}
                    >
                      <span className={styles.stepDot} />
                      Ativando modo ONLINE
                    </li>
                  </ul>
                  {onlineStatus && <p className={styles.helperText}>{onlineStatus}</p>}

                  {onlineStep === 'needs_sunshine' && (
                    <div className={styles.connectionPanel}>
                      <p>Sunshine nao detectado.</p>
                      <div className={styles.modalActions}>
                        <button type="button" onClick={handleSunshineBrowse}>
                          Procurar Sunshine...
                        </button>
                        <button type="button" onClick={handleSunshineAutoDetect} className={styles.ghost}>
                          Localizar automaticamente
                        </button>
                        <button type="button" onClick={handleOnlineRetry} className={styles.ghost}>
                          Tentar novamente
                        </button>
                      </div>
                      {sunshineHelpStatus && <p className={styles.helperText}>{sunshineHelpStatus}</p>}
                    </div>
                  )}

                  {onlineStep === 'needs_connection' && (
                    <div className={styles.connectionPanel}>
                      <label>
                        Connection Host (IP/DNS)
                        <input
                          value={onlineConnection.host}
                          onChange={(event) =>
                            setOnlineConnection((prev) => ({ ...prev, host: event.target.value }))
                          }
                          placeholder="100.103.x.x ou 192.168.x.x"
                        />
                      </label>
                      <label>
                        Connection Port
                        <input
                          type="number"
                          value={onlineConnection.port}
                          onChange={(event) =>
                            setOnlineConnection((prev) => ({
                              ...prev,
                              port: Number(event.target.value),
                            }))
                          }
                        />
                      </label>
                      <div className={styles.modalActions}>
                        <button type="button" onClick={handleAutoFillConnection} className={styles.ghost}>
                          Preencher automaticamente
                        </button>
                        <button type="button" onClick={handleOnlineRetry}>
                          Continuar
                        </button>
                      </div>
                    </div>
                  )}

                  {onlineStep === 'error' && (
                    <div className={styles.errorBox}>
                      <p>{onlineError || 'Nao foi possivel ficar ONLINE.'}</p>
                    </div>
                  )}

                  {onlineStep === 'done' && (
                    <div className={styles.modalRow}>
                      <span className={styles.spinner} />
                      <span>ONLINE ✅</span>
                    </div>
                  )}

                  <div className={styles.modalActions}>
                    <button
                      type="button"
                      onClick={handleOnlineCancel}
                      className={styles.ghost}
                      disabled={onlineBusy}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      )}
    </section>
  );
}
