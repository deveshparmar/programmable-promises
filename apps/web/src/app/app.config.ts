import { HttpInterceptorFn, provideHttpClient, withInterceptors } from "@angular/common/http";
import { ApplicationConfig } from "@angular/core";
import { provideRouter } from "@angular/router";
import { SKIP_PAYER_AUTH } from "./api.service";
import { routes } from "./app.routes";

const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.context.get(SKIP_PAYER_AUTH)) return next(req);
  const token = sessionStorage.getItem("pp_token");
  if (!token) return next(req);
  return next(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }));
};

export const appConfig: ApplicationConfig = {
  providers: [provideRouter(routes), provideHttpClient(withInterceptors([authInterceptor]))],
};
