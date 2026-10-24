import { HttpInterceptorFn, provideHttpClient, withInterceptors } from "@angular/common/http";
import { ApplicationConfig } from "@angular/core";
import { provideRouter } from "@angular/router";
import { SHARE_TOKEN, SKIP_PAYER_AUTH } from "./api.service";
import { routes } from "./app.routes";

const authInterceptor: HttpInterceptorFn = (req, next) => {
  const shareToken = req.context.get(SHARE_TOKEN);
  const payerToken = req.context.get(SKIP_PAYER_AUTH) ? null : sessionStorage.getItem("pp_token");
  if (!shareToken && !payerToken) return next(req);
  return next(req.clone({
    setHeaders: {
      ...(shareToken ? { "X-Share-Token": shareToken } : {}),
      ...(payerToken ? { Authorization: `Bearer ${payerToken}` } : {}),
    },
  }));
};

export const appConfig: ApplicationConfig = {
  providers: [provideRouter(routes), provideHttpClient(withInterceptors([authInterceptor]))],
};
