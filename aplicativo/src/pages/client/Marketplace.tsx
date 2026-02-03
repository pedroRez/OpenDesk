import type { FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useToast } from '../../components/Toast';
import { request } from '../../lib/api';
import { useAuth } from '../../lib/auth';

import styles from './Marketplace.module.css';

type PCCategory = 'GAMES' | 'DESIGN' | 'VIDEO' | 'DEV' | 'OFFICE';
type ReliabilityBadge = 'CONFIAVEL' | 'NOVO' | 'INSTAVEL';

type PCSpecSummary = {
  cpu?: string;
  gpu?: string;
  ram?: string;
};

type PC = {
  id: string;
  name: string;
  level: string;
  pricePerHour: number;
  status: 'ONLINE' | 'OFFLINE' | 'BUSY';
  queueCount: number;
  reliabilityBadge?: ReliabilityBadge;
  categories?: PCCategory[];
  softwareTags?: string[];
  specSummary?: PCSpecSummary | null;
  description?: string | null;
  host?: { id: string; displayName: string } | null;
  cpu?: string;
  ramGb?: number;
  gpu?: string;
  vramGb?: number;
  storageType?: string;
  internetUploadMbps?: number;
};

type FavoriteItem = {
  id: string;
  pcId: string | null;
  hostId: string | null;
  createdAt: string;
  pc: { id: string; name: string; status: 'ONLINE' | 'OFFLINE' | 'BUSY'; queueCount: number } | null;
  host: { id: string; displayName: string } | null;
};

type FavoritePcTarget = Pick<PC, 'id' | 'name' | 'status' | 'queueCount'>;

type ReservationSlot = {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
};

type QueueJoinResponse =
  | { status: 'ACTIVE'; sessionId: string | null; queueCount: number }
  | { status: 'WAITING'; position: number; queueCount: number };

const DEFAULT_MINUTES = 60;
const CATEGORY_LABELS: Record<PCCategory, string> = {
  GAMES: 'Jogos',
  DESIGN: 'Design',
  VIDEO: 'Video',
  DEV: 'Dev',
  OFFICE: 'Office',
};
const RELIABILITY_LABELS: Record<ReliabilityBadge, string> = {
  CONFIAVEL: 'Confiavel',
  NOVO: 'Novo',
  INSTAVEL: 'Instavel',
};
const RELIABILITY_TOOLTIP = 'Baseado em sessoes concluidas e tempo online recente.';

const formatDateInput = (value: Date) => {
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, '0');
  const day = `${value.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatTimeInput = (value: Date) => {
  const hours = `${value.getHours()}`.padStart(2, '0');
  const minutes = `${value.getMinutes()}`.padStart(2, '0');
  return `${hours}:${minutes}`;
};

const formatTime = (value: string) =>
  new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

const formatDateLabel = (value: Date) =>
  value.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

const formatSpecSummary = (pc: PC) => {
  const summary = pc.specSummary ?? {};
  const cpu = summary.cpu ?? pc.cpu;
  const gpu = summary.gpu ?? pc.gpu;
  const ramRaw = summary.ram ?? (pc.ramGb ? `${pc.ramGb} GB` : undefined);
  const ram =
    ramRaw && ramRaw.toLowerCase().includes('ram') ? ramRaw : ramRaw ? `${ramRaw} RAM` : undefined;
  const parts = [gpu, ram, cpu].filter(Boolean);
  return parts.length > 0 ? parts.join(' | ') : '';
};

const truncate = (value: string | null | undefined, max = 120) => {
  if (!value) return '';
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trim()}...`;
};

export default function Marketplace() {
  const [pcs, setPcs] = useState<PC[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [favoritesLoading, setFavoritesLoading] = useState(false);
  const [favoritesError, setFavoritesError] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<PCCategory[]>([]);
  const [selectedSoftwareTags, setSelectedSoftwareTags] = useState<string[]>([]);
  const [connectingPcId, setConnectingPcId] = useState<string | null>(null);
  const [schedulePc, setSchedulePc] = useState<PC | null>(null);
  const [scheduleDate, setScheduleDate] = useState(() => formatDateInput(new Date()));
  const [scheduleTime, setScheduleTime] = useState(() => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    now.setHours(now.getHours() + 1);
    return formatTimeInput(now);
  });
  const [scheduleDuration, setScheduleDuration] = useState(60);
  const [availability, setAvailability] = useState<ReservationSlot[]>([]);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState('');
  const [scheduling, setScheduling] = useState(false);

  const { user, isAuthenticated } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const loadPcs = async (showLoading = false) => {
    if (showLoading) {
      setIsLoading(true);
      setError('');
    }
    try {
      const data = await request<PC[]>('/pcs');
      setPcs(data);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar PCs');
    } finally {
      if (showLoading) {
        setIsLoading(false);
      }
    }
  };

  const loadFavorites = async () => {
    if (!isAuthenticated) {
      setFavorites([]);
      setFavoritesError('');
      return;
    }
    setFavoritesLoading(true);
    try {
      const data = await request<FavoriteItem[]>('/favorites');
      setFavorites(data ?? []);
      setFavoritesError('');
    } catch (err) {
      setFavoritesError(err instanceof Error ? err.message : 'Erro ao carregar favoritos');
    } finally {
      setFavoritesLoading(false);
    }
  };

  useEffect(() => {
    loadPcs(true);
    const intervalId = setInterval(() => loadPcs(false), 12000);
    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      loadFavorites();
    } else {
      setFavorites([]);
      setFavoritesError('');
    }
  }, [isAuthenticated, user?.id]);

  const statusCounts = useMemo(() => {
    return pcs.reduce(
      (acc, pc) => {
        acc.total += 1;
        if (pc.status === 'ONLINE') acc.online += 1;
        if (pc.status === 'BUSY') acc.busy += 1;
        if (pc.status === 'OFFLINE') acc.offline += 1;
        return acc;
      },
      { total: 0, online: 0, busy: 0, offline: 0 },
    );
  }, [pcs]);

  const favoritePcIds = useMemo(
    () => new Set(favorites.filter((favorite) => favorite.pcId).map((favorite) => favorite.pcId!)),
    [favorites],
  );

  const favoriteHostIds = useMemo(
    () =>
      new Set(favorites.filter((favorite) => favorite.hostId).map((favorite) => favorite.hostId!)),
    [favorites],
  );

  const availableSoftwareTags = useMemo(() => {
    const set = new Set<string>();
    pcs.forEach((pc) => {
      pc.softwareTags?.forEach((tag) => {
        if (tag && tag.trim()) {
          set.add(tag.trim());
        }
      });
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [pcs]);

  const filtersActive = selectedCategories.length > 0 || selectedSoftwareTags.length > 0;

  const filteredPcs = useMemo(() => {
    return pcs.filter((pc) => {
      const categories = pc.categories ?? [];
      const tags = pc.softwareTags ?? [];
      const matchesCategory =
        selectedCategories.length === 0 ||
        categories.some((category) => selectedCategories.includes(category));
      const matchesTags =
        selectedSoftwareTags.length === 0 ||
        tags.some((tag) => selectedSoftwareTags.includes(tag));
      return matchesCategory && matchesTags;
    });
  }, [pcs, selectedCategories, selectedSoftwareTags]);

  const handleToggleFavoritePc = async (pc: FavoritePcTarget) => {
    if (!isAuthenticated || !user) {
      toast.show('Faca login para favoritar.', 'info');
      navigate(`/login?next=${encodeURIComponent('/client/marketplace')}`);
      return;
    }

    const isFavorite = favoritePcIds.has(pc.id);
    const previous = favorites;

    if (isFavorite) {
      setFavorites((prev) => prev.filter((favorite) => favorite.pcId !== pc.id));
      try {
        await request('/favorites', {
          method: 'DELETE',
          body: JSON.stringify({ pcId: pc.id }),
        });
      } catch (err) {
        setFavorites(previous);
        toast.show(err instanceof Error ? err.message : 'Erro ao desfavoritar', 'error');
      }
      return;
    }

    const optimistic: FavoriteItem = {
      id: `temp-pc-${pc.id}`,
      pcId: pc.id,
      hostId: null,
      createdAt: new Date().toISOString(),
      pc: {
        id: pc.id,
        name: pc.name,
        status: pc.status,
        queueCount: pc.queueCount,
      },
      host: null,
    };

    setFavorites((prev) => [optimistic, ...prev]);
    try {
      const response = await request<{ favorite: { id: string; createdAt: string } }>('/favorites', {
        method: 'POST',
        body: JSON.stringify({ pcId: pc.id }),
      });
      setFavorites((prev) =>
        prev.map((item) =>
          item.id === optimistic.id
            ? { ...item, id: response.favorite.id, createdAt: response.favorite.createdAt }
            : item,
        ),
      );
    } catch (err) {
      setFavorites(previous);
      toast.show(err instanceof Error ? err.message : 'Erro ao favoritar', 'error');
    }
  };

  const handleToggleFavoriteHost = async (hostId: string, displayName: string) => {
    if (!isAuthenticated || !user) {
      toast.show('Faca login para favoritar.', 'info');
      navigate(`/login?next=${encodeURIComponent('/client/marketplace')}`);
      return;
    }

    const isFavorite = favoriteHostIds.has(hostId);
    const previous = favorites;

    if (isFavorite) {
      setFavorites((prev) => prev.filter((favorite) => favorite.hostId !== hostId));
      try {
        await request('/favorites', {
          method: 'DELETE',
          body: JSON.stringify({ hostId }),
        });
      } catch (err) {
        setFavorites(previous);
        toast.show(err instanceof Error ? err.message : 'Erro ao desfavoritar host', 'error');
      }
      return;
    }

    const optimistic: FavoriteItem = {
      id: `temp-host-${hostId}`,
      pcId: null,
      hostId,
      createdAt: new Date().toISOString(),
      pc: null,
      host: { id: hostId, displayName },
    };

    setFavorites((prev) => [optimistic, ...prev]);
    try {
      const response = await request<{ favorite: { id: string; createdAt: string } }>('/favorites', {
        method: 'POST',
        body: JSON.stringify({ hostId }),
      });
      setFavorites((prev) =>
        prev.map((item) =>
          item.id === optimistic.id
            ? { ...item, id: response.favorite.id, createdAt: response.favorite.createdAt }
            : item,
        ),
      );
    } catch (err) {
      setFavorites(previous);
      toast.show(err instanceof Error ? err.message : 'Erro ao favoritar host', 'error');
    }
  };

  const handleConnectNow = async (pc: PC) => {
    if (!isAuthenticated || !user) {
      toast.show('Faca login para conectar.', 'info');
      navigate(`/login?next=${encodeURIComponent('/client/marketplace')}`);
      return;
    }

    setConnectingPcId(pc.id);
    try {
      const response = await request<QueueJoinResponse>(`/pcs/${pc.id}/queue/join`, {
        method: 'POST',
        body: JSON.stringify({ minutesPurchased: DEFAULT_MINUTES }),
      });

      setPcs((prev) =>
        prev.map((item) =>
          item.id === pc.id
            ? {
                ...item,
                queueCount: response.queueCount,
              }
            : item,
        ),
      );

      if (response.status === 'ACTIVE' && response.sessionId) {
        toast.show('Sessao criada. Conectando...', 'success');
        navigate(`/client/session/${response.sessionId}`);
        return;
      }

      if (response.status === 'WAITING') {
        toast.show(`Entrou na fila. Posicao: ${response.position}`, 'info');
        navigate(`/client/queue/${pc.id}`);
      }
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Erro ao conectar', 'error');
    } finally {
      setConnectingPcId(null);
    }
  };

  const openSchedule = (pc: PC) => {
    if (!isAuthenticated || !user) {
      toast.show('Faca login para agendar.', 'info');
      navigate(`/login?next=${encodeURIComponent('/client/marketplace')}`);
      return;
    }
    setScheduleError('');
    setAvailability([]);
    setSchedulePc(pc);
  };

  const closeSchedule = () => {
    setSchedulePc(null);
    setScheduleError('');
  };

  const loadAvailability = async (pcId: string, date: string) => {
    setAvailabilityLoading(true);
    setScheduleError('');
    try {
      const data = await request<{ reservations: ReservationSlot[] }>(
        `/pcs/${pcId}/reservations/availability?date=${date}`,
      );
      setAvailability(data.reservations ?? []);
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : 'Erro ao carregar horarios.');
    } finally {
      setAvailabilityLoading(false);
    }
  };

  useEffect(() => {
    if (!schedulePc) return;
    loadAvailability(schedulePc.id, scheduleDate);
  }, [schedulePc, scheduleDate]);

  const handleScheduleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!schedulePc) return;

    const startAt = new Date(`${scheduleDate}T${scheduleTime}`);
    if (Number.isNaN(startAt.getTime())) {
      setScheduleError('Horario invalido.');
      return;
    }

    setScheduling(true);
    setScheduleError('');
    try {
      await request(`/pcs/${schedulePc.id}/reservations`, {
        method: 'POST',
        body: JSON.stringify({
          startAt: startAt.toISOString(),
          durationMin: scheduleDuration,
        }),
      });

      toast.show(
        `Reserva criada para ${formatDateLabel(startAt)} as ${formatTimeInput(startAt)}.`,
        'success',
      );
      closeSchedule();
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : 'Erro ao agendar');
    } finally {
      setScheduling(false);
    }
  };

  const handleCategoryToggle = (category: PCCategory) => {
    setSelectedCategories((prev) =>
      prev.includes(category) ? prev.filter((item) => item !== category) : [...prev, category],
    );
  };

  const handleSoftwareToggle = (tag: string) => {
    setSelectedSoftwareTags((prev) =>
      prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag],
    );
  };

  const clearFilters = () => {
    setSelectedCategories([]);
    setSelectedSoftwareTags([]);
  };

  return (
    <section className={styles.container}>
      <header className={styles.header}>
        <div>
          <h1>Marketplace</h1>
          <p>Escolha um PC e conecte agora ou agende um horario.</p>
        </div>
        <div className={styles.counter}>
          {statusCounts.total} PCs | {statusCounts.online} online | {statusCounts.busy} ocupados
        </div>
      </header>

      <section className={styles.favoritesPanel}>
        <div className={styles.favoritesHeader}>
          <div>
            <h2>Favoritos</h2>
            <p className={styles.muted}>Acesse rapidamente os PCs e Hosts que voce gosta.</p>
          </div>
          <span className={styles.favoritesCount}>{favorites.length} itens</span>
        </div>
        {!isAuthenticated && (
          <p className={styles.muted}>Faca login para salvar favoritos e acessar esta lista.</p>
        )}
        {isAuthenticated && favoritesLoading && <p>Carregando favoritos...</p>}
        {isAuthenticated && favoritesError && <p className={styles.errorInline}>{favoritesError}</p>}
        {isAuthenticated && !favoritesLoading && !favoritesError && favorites.length === 0 && (
          <p className={styles.muted}>Nenhum favorito ainda. Use a estrela nos cards.</p>
        )}
        {favorites.length > 0 && (
          <ul className={styles.favoritesList}>
            {favorites.map((favorite) => {
              if (favorite.pc) {
                return (
                  <li key={favorite.id} className={styles.favoriteItem}>
                    <div className={styles.favoriteInfo}>
                      <strong>{favorite.pc.name}</strong>
                      <div className={styles.favoriteMeta}>
                        <span>Status: {favorite.pc.status}</span>
                        <span>Fila: {favorite.pc.queueCount}</span>
                      </div>
                    </div>
                    <div className={styles.favoriteActions}>
                      <Link className={styles.favoriteLink} to={`/client/pcs/${favorite.pc.id}`}>
                        Ver detalhes
                      </Link>
                      <button
                        type="button"
                        className={styles.favoriteToggle}
                        onClick={() => favorite.pc && handleToggleFavoritePc(favorite.pc)}
                        aria-label="Desfavoritar PC"
                      >
                        ★
                      </button>
                    </div>
                  </li>
                );
              }
              if (favorite.host) {
                return (
                  <li key={favorite.id} className={styles.favoriteItem}>
                    <div className={styles.favoriteInfo}>
                      <strong>{favorite.host.displayName}</strong>
                      <div className={styles.favoriteMeta}>
                        <span>Host favorito</span>
                      </div>
                    </div>
                    <div className={styles.favoriteActions}>
                      <button
                        type="button"
                        className={styles.favoriteToggle}
                        onClick={() =>
                          handleToggleFavoriteHost(favorite.host!.id, favorite.host!.displayName)
                        }
                        aria-label="Desfavoritar host"
                      >
                        ★
                      </button>
                    </div>
                  </li>
                );
              }
              return null;
            })}
          </ul>
        )}
      </section>

      <section className={styles.filters}>
        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Categorias</span>
          <div className={styles.filterOptions}>
            {Object.entries(CATEGORY_LABELS).map(([key, label]) => {
              const category = key as PCCategory;
              return (
                <label key={category} className={styles.filterOption}>
                  <input
                    type="checkbox"
                    checked={selectedCategories.includes(category)}
                    onChange={() => handleCategoryToggle(category)}
                  />
                  {label}
                </label>
              );
            })}
          </div>
        </div>
        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Softwares e plataformas</span>
          <div className={styles.filterOptions}>
            {availableSoftwareTags.length === 0 && <span className={styles.muted}>Sem tags.</span>}
            {availableSoftwareTags.map((tag) => (
              <label key={tag} className={styles.filterOption}>
                <input
                  type="checkbox"
                  checked={selectedSoftwareTags.includes(tag)}
                  onChange={() => handleSoftwareToggle(tag)}
                />
                {tag}
              </label>
            ))}
          </div>
        </div>
        <button
          type="button"
          className={styles.clearFilters}
          onClick={clearFilters}
          disabled={!filtersActive}
        >
          Limpar filtros
        </button>
      </section>

      {isLoading && <p>Carregando PCs...</p>}
      {error && (
        <div className={styles.error}>
          <div>
            <strong>Falha ao carregar PCs</strong>
            <p>{error}</p>
          </div>
          <button type="button" onClick={() => loadPcs(true)} className={styles.retryButton}>
            Tentar novamente
          </button>
        </div>
      )}
      {!isLoading && !error && pcs.length === 0 && (
        <div className={styles.empty}>Nenhum PC disponivel no momento. Tente novamente em alguns instantes.</div>
      )}
      {!isLoading && !error && pcs.length > 0 && filteredPcs.length === 0 && filtersActive && (
        <div className={styles.empty}>Nenhum PC corresponde aos filtros selecionados.</div>
      )}

      <div className={styles.grid}>
        {filteredPcs.map((pc) => {
          const isOffline = pc.status === 'OFFLINE';
          const isBusy = pc.status === 'BUSY';
          const statusClass =
            pc.status === 'ONLINE'
              ? styles.statusOnline
              : pc.status === 'BUSY'
                ? styles.statusBusy
                : styles.statusOffline;
          const specSummary = formatSpecSummary(pc);
          const description = truncate(pc.description, 140);
          const isFavoritePc = favoritePcIds.has(pc.id);
          const hostName = pc.host?.displayName ?? 'N/A';
          const hostId = pc.host?.id ?? null;
          const isFavoriteHost = hostId ? favoriteHostIds.has(hostId) : false;
          const reliabilityValue: ReliabilityBadge = pc.reliabilityBadge ?? 'NOVO';
          const reliabilityLabel = RELIABILITY_LABELS[reliabilityValue];
          const reliabilityClass =
            reliabilityValue === 'CONFIAVEL'
              ? styles.reliabilityConfiavel
              : reliabilityValue === 'INSTAVEL'
                ? styles.reliabilityInstavel
                : styles.reliabilityNovo;
          return (
            <article key={pc.id} className={styles.card}>
              <div>
                <div className={styles.cardHeader}>
                  <div>
                    <h3>{pc.name}</h3>
                    <p>Nivel {pc.level}</p>
                  </div>
                  <div className={styles.cardHeaderActions}>
                    <button
                      type="button"
                      className={`${styles.favoriteToggle} ${isFavoritePc ? styles.favoriteActive : ''}`}
                      onClick={() => handleToggleFavoritePc(pc)}
                      aria-label={isFavoritePc ? 'Desfavoritar PC' : 'Favoritar PC'}
                    >
                      {isFavoritePc ? '★' : '☆'}
                    </button>
                    <span className={`${styles.statusBadge} ${statusClass}`}>{pc.status}</span>
                  </div>
                </div>
                <div
                  className={`${styles.reliabilityBadge} ${reliabilityClass}`}
                  title={RELIABILITY_TOOLTIP}
                >
                  <span className={styles.reliabilityDot} />
                  {reliabilityLabel}
                </div>
                <div className={styles.hostLine}>
                  <span>Host: {hostName}</span>
                  {hostId && (
                    <button
                      type="button"
                      className={`${styles.favoriteToggle} ${isFavoriteHost ? styles.favoriteActive : ''}`}
                      onClick={() => handleToggleFavoriteHost(hostId, hostName)}
                      aria-label={isFavoriteHost ? 'Desfavoritar host' : 'Favoritar host'}
                    >
                      {isFavoriteHost ? '★' : '☆'}
                    </button>
                  )}
                </div>
                {pc.categories && pc.categories.length > 0 && (
                  <div className={styles.tagRow}>
                    {pc.categories.map((category) => (
                      <span key={category} className={`${styles.tag} ${styles.tagCategory}`}>
                        {CATEGORY_LABELS[category] ?? category}
                      </span>
                    ))}
                  </div>
                )}
                {pc.softwareTags && pc.softwareTags.length > 0 && (
                  <div className={styles.tagRow}>
                    {pc.softwareTags.map((tag) => (
                      <span key={`${pc.id}-${tag}`} className={`${styles.tag} ${styles.tagSoftware}`}>
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                {specSummary && <p className={styles.specSummary}>{specSummary}</p>}
                {description && <p className={styles.description}>{description}</p>}
                <ul className={styles.specs}>
                  <li>
                    <strong>CPU:</strong> {pc.cpu ?? 'Nao informado'}
                  </li>
                  <li>
                    <strong>RAM:</strong> {pc.ramGb ? `${pc.ramGb} GB` : 'Nao informado'}
                  </li>
                  <li>
                    <strong>GPU:</strong>{' '}
                    {pc.gpu ? `${pc.gpu}${pc.vramGb ? ` (${pc.vramGb} GB VRAM)` : ''}` : 'Nao informado'}
                  </li>
                  <li>
                    <strong>Storage:</strong> {pc.storageType ?? 'Nao informado'}
                  </li>
                  <li>
                    <strong>Upload:</strong>{' '}
                    {pc.internetUploadMbps ? `${pc.internetUploadMbps} Mbps` : 'Nao informado'}
                  </li>
                </ul>
              </div>
              <div className={styles.cardMeta}>
                <span>R$ {pc.pricePerHour}/hora</span>
                <span className={styles.queue}>Fila: {pc.queueCount}</span>
              </div>
              <div className={styles.cardActions}>
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => handleConnectNow(pc)}
                  disabled={isOffline || connectingPcId === pc.id}
                >
                  {connectingPcId === pc.id
                    ? 'Conectando...'
                    : isBusy
                      ? 'Conectar agora (entrar na fila)'
                      : 'Conectar agora'}
                </button>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => openSchedule(pc)}
                  disabled={isOffline}
                >
                  Agendar
                </button>
                <Link className={styles.secondaryLink} to={`/client/pcs/${pc.id}`}>
                  Ver detalhes
                </Link>
              </div>
            </article>
          );
        })}
      </div>

      <footer className={styles.policyNote}>
        O OpenDesk nao fornece jogos ou softwares. O usuario utiliza suas proprias contas e licencas.
      </footer>

      {schedulePc && (
        <div className={styles.scheduleOverlay} role="dialog" aria-modal="true">
          <div className={styles.schedulePanel}>
            <div className={styles.scheduleHeader}>
              <div>
                <h2>Agendar PC</h2>
                <p>{schedulePc.name}</p>
              </div>
              <button type="button" onClick={closeSchedule} className={styles.closeButton}>
                Fechar
              </button>
            </div>
            <form onSubmit={handleScheduleSubmit} className={styles.scheduleForm}>
              <label>
                Data
                <input
                  type="date"
                  value={scheduleDate}
                  onChange={(event) => setScheduleDate(event.target.value)}
                  required
                />
              </label>
              <label>
                Hora
                <input
                  type="time"
                  value={scheduleTime}
                  onChange={(event) => setScheduleTime(event.target.value)}
                  required
                />
              </label>
              <label>
                Duracao
                <select
                  value={scheduleDuration}
                  onChange={(event) => setScheduleDuration(Number(event.target.value))}
                >
                  <option value={30}>30 minutos</option>
                  <option value={60}>1 hora</option>
                  <option value={120}>2 horas</option>
                </select>
              </label>

              <div className={styles.availability}>
                <strong>Horarios indisponiveis</strong>
                {availabilityLoading && <span>Carregando horarios...</span>}
                {!availabilityLoading && availability.length === 0 && (
                  <span className={styles.muted}>Sem bloqueios neste dia.</span>
                )}
                {!availabilityLoading && availability.length > 0 && (
                  <ul>
                    {availability.map((slot) => (
                      <li key={slot.id}>
                        {formatTime(slot.startAt)} - {formatTime(slot.endAt)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {scheduleError && <div className={styles.errorInline}>{scheduleError}</div>}
              <button type="submit" className={styles.primaryButton} disabled={scheduling}>
                {scheduling ? 'Agendando...' : 'Confirmar agendamento'}
              </button>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
