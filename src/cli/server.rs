use crate::{
    cli::ServerConfig,
    spell::{ProveRequest, ProveSpellTx, ProveSpellTxImpl},
    utils::TRANSIENT_PROVER_FAILURE,
};
use anyhow::Result;
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone)]
struct ServerState {
    prover: Arc<ProveSpellTxImpl>,
    auth_token: Option<Arc<str>>,
}

pub struct Server {
    pub config: ServerConfig,
    state: ServerState,
}

// Types
#[derive(Debug, Serialize, Deserialize)]
struct ShowSpellRequest {
    tx_hex: String,
}

/// Creates a permissive CORS configuration layer for the API server.
///
/// This configuration:
/// - Allows requests from any origin
/// - Allows all HTTP methods
/// - Allows all headers to be sent
/// - Exposes all headers to the client
/// - Sets a max age of 1 hour (3600 seconds) for preflight requests
fn cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers(Any)
        .max_age(Duration::from_secs(3600))
}

impl Server {
    pub fn new(config: ServerConfig, prover: ProveSpellTxImpl) -> Self {
        let prover = Arc::new(prover);
        let auth_token = config.auth_token.as_ref().and_then(|token| {
            let trimmed = token.trim();
            (!trimmed.is_empty()).then(|| Arc::<str>::from(trimmed))
        });

        let state = ServerState { prover, auth_token };

        Self { config, state }
    }

    pub async fn serve(&self) -> Result<()> {
        let ServerConfig { ip, port, .. } = &self.config;

        // Build router with CORS middleware
        let app = Router::new();
        let app = app
            .route("/spells/prove", post(prove_spell))
            .with_state(self.state.clone())
            .route("/ready", get(|| async { "OK" }))
            .layer(cors_layer());

        if self.state.auth_token.is_none() {
            tracing::warn!(
                "Server authentication disabled; requests will be accepted without an Authorization header"
            );
        }

        // Run server
        let addr = format!("{}:{}", ip, port);
        let listener = tokio::net::TcpListener::bind(&addr).await?;
        tracing::info!("Server running on {}", &addr);

        axum::serve(listener, app).await?;
        Ok(())
    }
}

// #[axum_macros::debug_handler]
#[tracing::instrument(level = "debug", skip_all)]
async fn prove_spell(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(payload): Json<ProveRequest>,
) -> Result<Json<Vec<String>>, (StatusCode, Json<String>)> {
    if let Some(expected_token) = state.auth_token.as_ref() {
        let provided = headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .map(|value| {
                value
                    .strip_prefix("Bearer ")
                    .map(str::trim)
                    .unwrap_or(value)
            });

        match provided {
            Some(token) if token == expected_token.as_ref() => {}
            _ => {
                tracing::warn!("Unauthorized request rejected");
                return Err((
                    StatusCode::UNAUTHORIZED,
                    Json("Unauthorized request".to_string()),
                ));
            }
        }
    }

    let result = state.prover.prove_spell_tx(payload).await.map_err(|e| {
        if e.to_string().contains(TRANSIENT_PROVER_FAILURE) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(e.to_string()));
        }
        (StatusCode::BAD_REQUEST, Json(e.to_string()))
    })?;
    Ok(Json(result))
}
