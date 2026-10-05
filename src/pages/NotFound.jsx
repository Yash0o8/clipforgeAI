import { Link } from 'react-router-dom';
import { FileQuestion, Home } from 'lucide-react';
import { Button } from '../components/common/Button.jsx';
import { EmptyState } from '../components/common/EmptyState.jsx';

/** 404 catch-all. */
export function NotFoundPage() {
  return (
    <EmptyState
      icon={<FileQuestion className="size-5" />}
      title="Page not found"
      description="That route doesn't exist. Head back to the dashboard."
      action={
        <Button as={Link} to="/">
          <Home aria-hidden className="size-4" />
          Back to home
        </Button>
      }
    />
  );
}












