import { BookCopy, BookOpen, CreditCard, Ellipsis, FileText, GraduationCap, IdCard, Image, Layers, Mail, Presentation, ScanLine, Shield, Stamp, type LucideIcon } from 'lucide-react'
import { serviceOf } from '@/lib/services'

const ICONS: Record<string, LucideIcon> = {
  book: BookOpen,
  graduation: GraduationCap,
  binder: BookCopy,
  layers: Layers,
  card: CreditCard,
  letter: FileText,
  stamp: Stamp,
  mail: Mail,
  banner: Presentation,
  id: IdCard,
  shield: Shield,
  image: Image,
  scan: ScanLine,
  more: Ellipsis,
}

/** The icon for an order service (lib/services.ts). */
export function ServiceIcon({ id, className = 'h-5 w-5' }: { id: string; className?: string }) {
  const Icon = ICONS[serviceOf(id).icon] ?? Ellipsis
  return <Icon className={className} aria-hidden />
}
