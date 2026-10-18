import { Navigate, useParams } from 'react-router-dom'

/** /s/:slug/blackbook — older links; blackbooks are now one of the order services. */
export default function BlackbookPage() {
  const { slug = '' } = useParams()
  return <Navigate to={`/s/${slug}/order/blackbook`} replace />
}
