export interface ProfileCardProps {
  name: string;
}

export function ProfileCard({ name }: ProfileCardProps) {
  return <article>{name}</article>;
}
