import { Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { ApiService } from "../api.service";

@Component({
  selector: "app-login",
  imports: [FormsModule],
  template: `
    <section class="stack">
      <h1>Pay when the work is real.</h1>
      <p class="lede">Hold the money with PayPal. Release it when a photo proves the work, or when you say so.</p>
      <form class="card stack" (ngSubmit)="submit()">
        <label>Payer email
          <input name="email" type="email" [(ngModel)]="email" placeholder="payer&#64;example.com" required />
        </label>
        <p class="muted">Demo sign-in. The seeded payer is payer&#64;example.com. There is no password.</p>
        @if (error()) { <p class="error">{{ error() }}</p> }
        <button class="primary" type="submit" [disabled]="busy()">Sign in</button>
      </form>
    </section>
  `,
})
export class LoginComponent {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  email = "payer@example.com";
  readonly busy = signal(false);
  readonly error = signal("");

  submit(): void {
    this.busy.set(true);
    this.error.set("");
    this.api.login(this.email).subscribe({
      next: (result) => {
        sessionStorage.setItem("pp_token", result.token);
        sessionStorage.setItem("pp_email", result.email);
        void this.router.navigateByUrl("/");
      },
      error: (error: Error) => {
        this.error.set(error.message);
        this.busy.set(false);
      },
    });
  }
}
