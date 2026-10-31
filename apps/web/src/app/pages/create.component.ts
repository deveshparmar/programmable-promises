import { Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { ApiService } from "../api.service";
import { buildWorkerUrl } from "../worker-url";
import { ToastService } from "../toast.service";
import { localDateInput, toMinor } from "../models";

@Component({
  selector: "app-create",
  imports: [FormsModule],
  template: `
    <section class="stack">
      <h1>Write the condition.</h1>
      <p class="lede">Say what the photo has to show. The checklist comes back for you to edit before any money is held.</p>
      <form class="card stack" (ngSubmit)="submit()">
        <label>What was promised
          <textarea name="description" [(ngModel)]="description" required></textarea>
        </label>
        <div class="row">
          <label>Amount in USD
            <input name="amount" [(ngModel)]="amount" placeholder="40.00" required />
          </label>
          <label>Worker PayPal email
            <input name="worker" type="email" [(ngModel)]="worker" required />
          </label>
          <label>Deadline, within 48 hours
            <input name="deadline" type="datetime-local" [(ngModel)]="deadline" required />
          </label>
        </div>
        <button class="primary" type="submit" [disabled]="busy()">{{ busy() ? "Writing the checklist…" : "Create promise" }}</button>
        @if (busy()) { <div class="progress-inline" aria-hidden="true"><div></div></div> }
      </form>
    </section>
  `,
})
export class CreateComponent {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  description = "Pay $40 when a photo shows the logo files on a desk: a wordmark, a symbol, and both in black and white.";
  amount = "40.00";
  worker = "";
  deadline = localDateInput(new Date(Date.now() + 24 * 60 * 60 * 1000));
  readonly busy = signal(false);

  submit(): void {
    const amountMinor = toMinor(this.amount);
    if (amountMinor === null || amountMinor < 100) {
      this.toast.error("Enter at least $1.00, with at most two decimal places.");
      return;
    }
    this.busy.set(true);
    this.api.create({
      description: this.description,
      amount_minor: amountMinor,
      worker_email: this.worker,
      deadline_at: new Date(this.deadline).toISOString(),
    }).subscribe({
      next: (promise) => {
        if (promise.share_token) {
          sessionStorage.setItem(`pp_share_${promise.id}`, promise.share_token);
          sessionStorage.setItem(`pp_worker_${promise.id}`, buildWorkerUrl(promise.id, promise.share_token));
        }
        this.toast.success("Promise created. Confirm the checklist, then fund it.");
        void this.router.navigate(["/promises", promise.id]);
      },
      error: () => this.busy.set(false),
    });
  }
}
