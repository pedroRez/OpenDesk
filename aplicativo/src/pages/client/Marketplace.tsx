import type { FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

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

const formatCompactSpecs = (pc: PC) => {
  const summary = pc.specSummary ?? {};
  const ramRaw = summary.ram ?? (pc.ramGb ? `${pc.ramGb}GB` : undefined);
  const ram = ramRaw ? ramRaw.replace(/\s+/g, '') : undefined;
  const cpu = summary.cpu ?? pc.cpu;
  const gpu = summary.gpu ?? pc.gpu;
  const storage = pc.storageType;
  const parts = [ram, cpu, gpu, storage].filter(Boolean);
  return parts.length > 0 ? parts.join(' | ') : '';
};

const truncate = (value: string | null | undefined, max = 120) => {
  if (!value) return '';
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trim()}...`;
};

const formatHostName = (host?: { id?: string; displayName?: string | null } | null) => {
  if (host?.displayName) return host.displayName;
  if (host?.id) {
    const suffix = host.id.replace(/-/g, '').slice(0, 4).toUpperCase();
    return `Host #${suffix}`;
  }
  return 'Host';
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
  const [searchQuery, setSearchQuery] = useState('');
  const [favoritesOpen, setFavoritesOpen] = useState(true);
  const [categoriesOpen, setCategoriesOpen] = useState(true);
  const [connectingPcId, setConnectingPcId] = useState<string | null>(null);
  const [detailsPc, setDetailsPc] = useState<PC | null>(null);
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

  const searchTokens = useMemo(
    () => searchQuery.toLowerCase().split(/\s+/).filter(Boolean),
    [searchQuery],
  );

  const filtersActive =
    selectedCategories.length > 0 || selectedSoftwareTags.length > 0 || searchTokens.length > 0;

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
      if (!matchesCategory || !matchesTags) return false;

      if (searchTokens.length === 0) return true;

      const specLine = formatCompactSpecs(pc);
      const categoryLabels = categories.map((category) => CATEGORY_LABELS[category] ?? category);
      const searchable = [
        pc.name,
        pc.host?.displayName,
        pc.cpu,
        pc.gpu,
        pc.storageType,
        pc.specSummary?.cpu,
        pc.specSummary?.gpu,
        pc.specSummary?.ram,
        specLine,
        ...(pc.softwareTags ?? []),
        ...categoryLabels,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const compact = searchable.replace(/\s+/g, '');

      return searchTokens.every((token) => searchable.includes(token) || compact.includes(token));
    });
  }, [pcs, selectedCategories, selectedSoftwareTags, searchTokens]);

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
    setSearchQuery('');
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

      <div className={styles.marketplaceLayout}>
        <aside className={styles.sidebar}>
          <div className={styles.sideSection}>
            <button
              type="button"
              className={styles.sideToggle}
              onClick={() => setFavoritesOpen((prev) => !prev)}
              aria-expanded={favoritesOpen}
            >
              <span>Favoritos</span>
              <span className={styles.chevron}>{favoritesOpen ? 'v' : '>'}</span>
            </button>
            {favoritesOpen && (
              <div className={styles.sideContent}>
                <span className={styles.sideCount}>{favorites.length} itens</span>
                {!isAuthenticated && (
                  <p className={styles.muted}>Faca login para salvar favoritos e acessar esta lista.</p>
                )}
                {isAuthenticated && favoritesLoading && <p>Carregando favoritos...</p>}
                {isAuthenticated && favoritesError && <p className={styles.errorInline}>{favoritesError}</p>}
                {isAuthenticated && !favoritesLoading && !favoritesError && favorites.length === 0 && (
                  <p className={styles.muted}>Nenhum favorito ainda.</p>
                )}
                {favorites.length > 0 && (
                  <ul className={styles.sideList}>
                    {favorites.map((favorite) => {
                      if (favorite.pc) {
                        const statusClass =
                          favorite.pc.status === 'ONLINE'
                            ? styles.statusOnline
                            : favorite.pc.status === 'BUSY'
                              ? styles.statusBusy
                              : styles.statusOffline;
                        return (
                          <li key={favorite.id} className={styles.sideItem}>
                            <button
                              type="button"
                              className={styles.sideItemMain}
                              onClick={() =>
                                setDetailsPc(pcs.find((pc) => pc.id === favorite.pc?.id) ?? null)
                              }
                            >
                              <span className={`${styles.statusDot} ${statusClass}`} />
                              <span className={styles.sideItemName}>{favorite.pc.name}</span>
                            </button>
                            <div className={styles.sideItemActions}>
                              <span className={styles.sideQueue}>fila {favorite.pc.queueCount}</span>
                              <button
                                type="button"
                                className={styles.iconButton}
                                onClick={() => handleToggleFavoritePc(favorite.pc)}
                                aria-label="Desfavoritar PC"
                              >
                                *
                              </button>
                            </div>
                          </li>
                        );
                      }
                      if (favorite.host) {
                        return (
                          <li key={favorite.id} className={styles.sideItem}>
                            <div className={styles.sideItemMain}>
                              <span className={styles.sideItemName}>{formatHostName(favorite.host)}</span>
                            </div>
                            <div className={styles.sideItemActions}>
                              <button
                                type="button"
                                className={styles.iconButton}
                                onClick={() =>
                                  handleToggleFavoriteHost(favorite.host!.id, favorite.host!.displayName)
                                }
                                aria-label="Desfavoritar host"
                              >
                                *
                              </button>
                            </div>
                          </li>
                        );
                      }
                      return null;
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className={styles.sideSection}>
            <button
              type="button"
              className={styles.sideToggle}
              onClick={() => setCategoriesOpen((prev) => !prev)}
              aria-expanded={categoriesOpen}
            >
              <span>Categorias</span>
              <span className={styles.chevron}>{categoriesOpen ? 'v' : '>'}</span>
            </button>
            {categoriesOpen && (
              <div className={styles.sideContent}>
                <div className={styles.sideOptions}>
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
            )}
          </div>
        </aside>

        <main className={styles.main}>
          <div className={styles.searchRow}>
            <div className={styles.searchField}>
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Buscar host, specs (ex: 16GB SSD RX6600)"
              />
            </div>
            <button
              type="button"
              className={styles.clearFilters}
              onClick={clearFilters}
              disabled={!filtersActive}
            >
              Limpar filtros
            </button>
          </div>

          <section className={styles.filters}>
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
            <div className={styles.empty}>
              Nenhum PC disponivel no momento. Tente novamente em alguns instantes.
            </div>
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
              const specLine = formatCompactSpecs(pc);
              const isFavoritePc = favoritePcIds.has(pc.id);
              const hostName = formatHostName(pc.host ?? null);
              const hostId = pc.host?.id ?? null;
              const isFavoriteHost = hostId ? favoriteHostIds.has(hostId) : false;
              return (
                <article key={pc.id} className={styles.card}>
                  <div className={styles.cardTop}>
                    <div className={styles.pcIcon} aria-hidden="true" />
                    <div className={styles.cardMain}>
                      <div className={styles.cardTitleRow}>
                        <span className={`${styles.statusDot} ${statusClass}`} />
                        <h3>{pc.name}</h3>
                        <button
                          type="button"
                          className={`${styles.iconButton} ${isFavoritePc ? styles.favoriteActive : ''}`}
                          onClick={() => handleToggleFavoritePc(pc)}
                          aria-label={isFavoritePc ? 'Desfavoritar PC' : 'Favoritar PC'}
                        >
                          {isFavoritePc ? '*' : '+'}
                        </button>
                        <button
                          type="button"
                          className={styles.iconButton}
                          onClick={() => setDetailsPc(pc)}
                          aria-label="Ver detalhes"
                        >
                          i
                        </button>
                      </div>
                      <div className={styles.hostRow}>
                        <span className={styles.hostName}>{hostName}</span>
                        {hostId && (
                          <button
                            type="button"
                            className={`${styles.iconButton} ${isFavoriteHost ? styles.favoriteActive : ''}`}
                            onClick={() => handleToggleFavoriteHost(hostId, hostName)}
                            aria-label={isFavoriteHost ? 'Desfavoritar host' : 'Favoritar host'}
                          >
                            {isFavoriteHost ? '*' : '+'}
                          </button>
                        )}
                      </div>
                      {specLine && <div className={styles.specLine}>{specLine}</div>}
                    </div>
                  </div>

                  <div className={styles.cardMeta}>
                    <span className={styles.price}>R$ {pc.pricePerHour}/hora</span>
                    <span className={styles.queue}>
                      <span className={styles.queueIcon} aria-hidden="true" />
                      {pc.queueCount} na fila
                    </span>
                  </div>

                  <div className={styles.cardActions}>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      onClick={() => handleConnectNow(pc)}
                      disabled={isOffline || connectingPcId === pc.id}
                    >
                      {connectingPcId === pc.id ? 'Conectando...' : isBusy ? 'Entrar na fila' : 'Conectar'}
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => openSchedule(pc)}
                      disabled={isOffline}
                    >
                      Agendar
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </main>
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

      {detailsPc && (
        <div className={styles.detailsOverlay} role="dialog" aria-modal="true">
          <div className={styles.detailsPanel}>
            <div className={styles.detailsHeader}>
              <div>
                <h2>{detailsPc.name}</h2>
                <p className={styles.muted}>Host: {formatHostName(detailsPc.host ?? null)}</p>
              </div>
              <button type="button" onClick={() => setDetailsPc(null)} className={styles.closeButton}>
                Fechar
              </button>
            </div>

            <div className={styles.detailsSection}>
              <strong>Specs</strong>
              <p className={styles.specSummary}>{formatSpecSummary(detailsPc)}</p>
              <ul className={styles.specs}>
                <li>
                  <strong>CPU:</strong> {detailsPc.cpu ?? 'Nao informado'}
                </li>
                <li>
                  <strong>RAM:</strong>{' '}
                  {detailsPc.ramGb ? `${detailsPc.ramGb} GB` : detailsPc.specSummary?.ram ?? 'Nao informado'}
                </li>
                <li>
                  <strong>GPU:</strong>{' '}
                  {detailsPc.gpu
                    ? `${detailsPc.gpu}${detailsPc.vramGb ? ` (${detailsPc.vramGb} GB VRAM)` : ''}`
                    : 'Nao informado'}
                </li>
                <li>
                  <strong>Storage:</strong> {detailsPc.storageType ?? 'Nao informado'}
                </li>
                <li>
                  <strong>Upload:</strong>{' '}
                  {detailsPc.internetUploadMbps ? `${detailsPc.internetUploadMbps} Mbps` : 'Nao informado'}
                </li>
              </ul>
            </div>

            {detailsPc.description && (
              <div className={styles.detailsSection}>
                <strong>Descricao</strong>
                <p className={styles.muted}>{truncate(detailsPc.description, 240)}</p>
              </div>
            )}

            {detailsPc.categories && detailsPc.categories.length > 0 && (
              <div className={styles.detailsSection}>
                <strong>Categorias</strong>
                <div className={styles.tagRow}>
                  {detailsPc.categories.map((category) => (
                    <span key={category} className={`${styles.tag} ${styles.tagCategory}`}>
                      {CATEGORY_LABELS[category] ?? category}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {detailsPc.softwareTags && detailsPc.softwareTags.length > 0 && (
              <div className={styles.detailsSection}>
                <strong>Softwares</strong>
                <div className={styles.tagRow}>
                  {detailsPc.softwareTags.map((tag) => (
                    <span key={`${detailsPc.id}-${tag}`} className={`${styles.tag} ${styles.tagSoftware}`}>
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className={styles.detailsSection}>
              <strong>Confiabilidade</strong>
              <p className={styles.muted}>
                {RELIABILITY_LABELS[detailsPc.reliabilityBadge ?? 'NOVO']} - {RELIABILITY_TOOLTIP}
              </p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
