type HostWithUser = {
  id: string;
  user?: { username?: string | null } | null;
};

export function getHostPublicName(host: HostWithUser): string {
  const username = host.user?.username?.trim();
  if (username) {
    return username;
  }
  const suffix = host.id.replace(/-/g, '').slice(0, 4).toUpperCase();
  return `Host #${suffix}`;
}

export function sanitizeHost<T extends HostWithUser>(host: T) {
  const { user, ...rest } = host;
  return {
    ...rest,
    displayName: getHostPublicName(host),
  } as Omit<T, 'user'> & { displayName: string };
}
