"use client";

import { useRouter } from "next/navigation";
import { AlertCircleIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

const ErrorPage = ({ error, reset }: Props) => {
  const router = useRouter();

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-4 text-center px-4">
      <AlertCircleIcon className="size-10 text-destructive" />
      <h1 className="text-2xl font-bold">Something went wrong</h1>
      <p className="text-muted-foreground text-sm max-w-md">
        {error.message || "An unexpected error occurred. Please try again."}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => router.push("/")}>
          Go home
        </Button>
        <Button onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
};

export default ErrorPage;
