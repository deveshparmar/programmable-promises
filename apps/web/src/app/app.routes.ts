import { inject } from "@angular/core";
import { CanActivateFn, Router, Routes } from "@angular/router";
import { CreateComponent } from "./pages/create.component";
import { DetailComponent } from "./pages/detail.component";
import { ListComponent } from "./pages/list.component";
import { LoginComponent } from "./pages/login.component";
import { ReviewComponent } from "./pages/review.component";
import { WorkerComponent } from "./pages/worker.component";

const authGuard: CanActivateFn = () => {
  if (sessionStorage.getItem("pp_token")) return true;
  return inject(Router).createUrlTree(["/login"]);
};

export const routes: Routes = [
  { path: "login", component: LoginComponent },
  { path: "", component: ListComponent, canActivate: [authGuard] },
  { path: "new", component: CreateComponent, canActivate: [authGuard] },
  { path: "review", component: ReviewComponent, canActivate: [authGuard] },
  { path: "promises/:id", component: DetailComponent, canActivate: [authGuard] },
  { path: "w/:id/:token", component: WorkerComponent },
  { path: "**", redirectTo: "" },
];
