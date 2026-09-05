import { Plug } from 'lucide-react';
const icons: Record<string, string> = {
  notion: '/integrations/notion.svg',
  google: '/integrations/google.png',
  github: '/integrations/github.svg',
};
export function IntegrationIcon({ id, size = 22 }: { id: string; size?: number }) {
  return icons[id] ? (
    <img
      className="integration-logo"
      src={icons[id]}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  ) : (
    <Plug size={size} />
  );
}
