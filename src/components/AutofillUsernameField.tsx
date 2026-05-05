import { useAuthStore } from "@/stores/authStore";

interface AutofillUsernameFieldProps {
  value?: string;
}

export default function AutofillUsernameField({
  value,
}: AutofillUsernameFieldProps) {
  const email = useAuthStore((s) => s.user?.email);
  const username = value || email || "kakusu-user";

  return (
    <input
      type="text"
      name="username"
      autoComplete="username"
      value={username}
      readOnly
      tabIndex={-1}
      aria-hidden="true"
      className="sr-only"
    />
  );
}
