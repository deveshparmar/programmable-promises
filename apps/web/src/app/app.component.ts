import { Component, inject } from "@angular/core";
import { Router, RouterLink, RouterOutlet } from "@angular/router";

@Component({
  selector: "app-root",
  imports: [RouterOutlet, RouterLink],
  template: `
    <div class="shell">
      <header class="top">
        <a class="brand" routerLink="/">Programmable <span>Promises</span></a>
        <nav>
          @if (signedIn()) {
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
  signOut(): void {
    sessionStorage.removeItem("pp_token");
    sessionStorage.removeItem("pp_email");
    void this.router.navigateByUrl("/login");
  }
}
