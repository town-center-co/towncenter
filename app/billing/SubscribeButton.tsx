"use client";

import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui";

export function SubscribeButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" loading={pending}>
      {label}
    </Button>
  );
}
