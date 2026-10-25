import { Injectable, signal } from "@angular/core";

export type ToastKind = "error" | "success" | "info";

export interface Toast {
  id: string;
  message: string;
  kind: ToastKind;
}

@Injectable({ providedIn: "root" })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);

  show(message: string, kind: ToastKind = "info"): void {
    const id = crypto.randomUUID();
    this.toasts.update((items) => [...items, { id, message, kind }]);
    const duration = kind === "error" ? 9000 : 5500;
    window.setTimeout(() => this.dismiss(id), duration);
  }

  error(message: string): void {
    this.show(message, "error");
  }

  success(message: string): void {
    this.show(message, "success");
  }

  info(message: string): void {
    this.show(message, "info");
  }

  dismiss(id: string): void {
    this.toasts.update((items) => items.filter((item) => item.id !== id));
  }
}
