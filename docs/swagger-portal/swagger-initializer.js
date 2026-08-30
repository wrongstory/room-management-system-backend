window.addEventListener("load", () => {
  window.ui = SwaggerUIBundle({
    url: "./openapi.json",
    dom_id: "#swagger-ui",
    deepLinking: true,
    displayRequestDuration: false,
    docExpansion: "list",
    filter: true,
    showCommonExtensions: true,
    persistAuthorization: false,
    supportedSubmitMethods: [],
    tryItOutEnabled: false,
    validatorUrl: null,
  });
});
