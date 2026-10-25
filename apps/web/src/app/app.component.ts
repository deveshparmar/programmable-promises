import { Component, inject } from "@angular/core";
import { Router, RouterLink, RouterOutlet } from "@angular/router";
import { UiFeedbackComponent } from "./ui-feedback.component";

@Component({
  selector: "app-root",
  imports: [RouterOutlet, RouterLink, UiFeedbackComponent],
  template: `
    <app-ui-feedback />
    <div class="shell">
      <header class="top">
        <a class="brand" routerLink="/">Programmable <span>Promises</span></a>
        <nav>
          @if (signedIn()) {
            <span class="muted">{{ payerEmail() }}</span>
            <a routerLink="/new">New promise</a>
            <a routerLink="/review">Review</a>
            <button class="text-button" type="button" (click)="signOut()">Sign out</button>
          }
        </nav>
      </header>
      <router-outlet />
    </div>
  `,
})
export class AppComponent {
  private readonly router = inject(Router);
  signedIn(): boolean {
    return Boolean(sessionStorage.getItem("pp_token"));
  }
  payerEmail(): string {
    return sessionStorage.getItem("pp_email") ?? "";
  }
  signOut(): void {
    sessionStorage.removeItem("pp_token");
    sessionStorage.removeItem("pp_email");
    void this.router.navigateByUrl("/login");
  }
}
