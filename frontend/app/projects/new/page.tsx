import { redirect } from 'next/navigation';

/** There is one way to create an agent: the live create flow. */
export default function NewProjectPage() {
  redirect('/new');
}
