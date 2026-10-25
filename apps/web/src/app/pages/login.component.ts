import { Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { ApiService } from "../api.service";
import { ToastService } from "../toast.service";

@Component({
  selector: "app-login",
  imports: [FormsModule],
  template: `
    <section class="stack">
      <h1>Pay when the work is real.</h1>
      <p class="lede">Hold the money with PayPal. Release it when a photo proves the work, or when you say so.</p>
      <form class="card stack" (ngSubmit)="submit()">
        <label>Payer email
          <input name="email" type="email" [(ngModel)]="email" placeholder="you&#64;example.com" required autocomplete="email" />
        </label>
        <p class="muted">Demo sign-in with any email. No password. Each address sees only its own promises.</p>
        <button class="primary" type="submit" [disabled]="busy()">{{ busy() ? "Signing in…" : "Sign in" }}</button>
        @if (busy()) { <div class="progress-inline" aria-hidden="true"><div></div></div> }
      </form>
    </section>
  `,
})
export class LoginComponent {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  email = "";
  readonly busy = signal(false);

  submit(): void {
    const email = this.email.trim();
    if (!email) {
      this.toast.error("Enter your email to continue.");
      return;
    }
    this.busy.set(true);
    this.api.login(email).subscribe({
      next: (result) => {
        sessionStorage.setItem("pp_token", result.token);
        sessionStorage.setItem("pp_email", result.email);
        this.toast.success(`Signed in as ${result.email}`);
        void this.router.navigateByUrl("/");
      },
      error: () => this.busy.set(false),
    });
  }
}
