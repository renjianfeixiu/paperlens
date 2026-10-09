use percent_encoding::percent_decode_str;
use reqwest::{
    header::{ACCEPT, LOCATION, USER_AGENT},
    redirect::Policy,
    Client, StatusCode, Url,
};
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const PDF_DIRECTORY: &str = "paperlens/pdfs";
pub(crate) const MAX_PDF_BYTES: usize = 100 * 1024 * 1024;
const PDF_PROBE_BYTES: usize = 1024;
const MAX_REDIRECTS: usize = 5;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const DNS_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_DISPLAY_NAME_BYTES: usize = 180;

static DOWNLOAD_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedPdf {
    /// Always relative to Tauri's AppLocalData directory.
    pub(crate) local_file_path: String,
    pub(crate) display_name: String,
    pub(crate) byte_size: u64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPdfError {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    http_status: Option<u16>,
}

impl DownloadPdfError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            http_status: None,
        }
    }

    fn with_status(status: StatusCode) -> Self {
        Self {
            code: "http-status",
            message: format!("论文网站返回了 HTTP {}，暂时无法下载这份 PDF。", status.as_u16()),
            http_status: Some(status.as_u16()),
        }
    }
}

fn invalid_url(message: impl Into<String>) -> DownloadPdfError {
    DownloadPdfError::new("invalid-url", message)
}

fn unsafe_url(message: impl Into<String>) -> DownloadPdfError {
    DownloadPdfError::new("unsafe-url", message)
}

fn validate_download_url(url: &Url) -> Result<(), DownloadPdfError> {
    if url.scheme() != "https" {
        return Err(unsafe_url("为保护本机安全，仅允许从 HTTPS 地址下载 PDF。"));
    }

    if !url.username().is_empty() || url.password().is_some() {
        return Err(unsafe_url("下载地址不得包含用户名或密码。"));
    }

    match url.host() {
        Some(url::Host::Domain(domain)) => {
            let domain = domain.trim_end_matches('.').to_ascii_lowercase();
            if domain == "localhost"
                || domain.ends_with(".localhost")
                || domain == "local"
                || domain.ends_with(".local")
            {
                return Err(unsafe_url("已拒绝访问本机或局域网地址。"));
            }
        }
        Some(url::Host::Ipv4(address)) if !is_public_ipv4(address) => {
            return Err(unsafe_url("已拒绝访问本机或私有 IPv4 地址。"));
        }
        Some(url::Host::Ipv6(address)) if !is_public_ipv6(address) => {
            return Err(unsafe_url("已拒绝访问本机或私有 IPv6 地址。"));
        }
        Some(_) => {}
        None => return Err(invalid_url("下载地址缺少有效的网站域名。")),
    }

    Ok(())
}

pub(crate) fn parse_download_url(raw_url: &str) -> Result<Url, DownloadPdfError> {
    let url = Url::parse(raw_url.trim())
        .map_err(|_| invalid_url("下载链接无效，请检查后重试。"))?;
    validate_download_url(&url)?;
    Ok(url)
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();

    if a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
    {
        return false;
    }

    true
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }

    let segments = address.segments();
    let is_global_unicast = (0x2000..=0x3fff).contains(&segments[0]);
    let is_documentation = segments[0] == 0x2001 && segments[1] == 0x0db8;
    is_global_unicast && !is_documentation
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn validate_resolved_addresses(addresses: &[SocketAddr]) -> Result<(), DownloadPdfError> {
    if addresses.is_empty() {
        return Err(DownloadPdfError::new(
            "network-failed",
            "下载地址未解析到可用的公开网络地址。",
        ));
    }

    if addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(unsafe_url(
            "下载域名解析到本机或私有网络地址，已停止请求。",
        ));
    }

    Ok(())
}

async fn pinned_client_for(url: &Url) -> Result<Client, DownloadPdfError> {
    let mut builder = Client::builder()
        // A proxy could resolve the target again and bypass the validated DNS
        // result, so downloads deliberately use a direct connection.
        .no_proxy()
        .https_only(true)
        .redirect(Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT);

    if let Some(url::Host::Domain(domain)) = url.host() {
        let port = url.port_or_known_default().unwrap_or(443);
        let addresses: Vec<SocketAddr> = tokio::time::timeout(
            DNS_TIMEOUT,
            tokio::net::lookup_host((domain, port)),
        )
        .await
        .map_err(|_| {
            DownloadPdfError::new("network-timeout", "解析下载地址超时，请稍后重试。")
        })?
        .map_err(|_| {
            DownloadPdfError::new("network-failed", "无法解析论文网站地址，请稍后重试。")
        })?
        .collect();
        validate_resolved_addresses(&addresses)?;
        builder = builder.resolve_to_addrs(domain, &addresses);
    }

    builder.build().map_err(network_error)
}

fn decoded_url_file_name(url: &Url) -> Option<String> {
    let last_segment = url
        .path_segments()?
        .filter(|part| !part.is_empty())
        .next_back()?;
    let decoded = percent_decode_str(last_segment).decode_utf8_lossy();
    (!decoded.trim().is_empty()).then(|| decoded.into_owned())
}

pub(crate) fn safe_pdf_name(suggested_name: Option<&str>, final_url: &Url) -> String {
    let candidate = suggested_name
        .filter(|name| !name.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| decoded_url_file_name(final_url))
        .unwrap_or_else(|| "document.pdf".to_owned());

    let base_name = candidate
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("document.pdf")
        .trim();
    let stem = base_name
        .get(..base_name.len().saturating_sub(4))
        .filter(|_| base_name.to_ascii_lowercase().ends_with(".pdf"))
        .unwrap_or(base_name);
    let mut sanitized: String = stem
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '-'
            } else {
                character
            }
        })
        .collect();

    sanitized = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");
    sanitized = truncate_utf8_bytes(
        sanitized.trim_matches(['.', ' ']),
        MAX_DISPLAY_NAME_BYTES,
    );
    let sanitized = sanitized.trim_matches(['.', ' ']);

    format!("{}.pdf", if sanitized.is_empty() { "document" } else { sanitized })
}

fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> String {
    let end = value
        .char_indices()
        .take_while(|(index, character)| index + character.len_utf8() <= max_bytes)
        .map(|(index, character)| index + character.len_utf8())
        .last()
        .unwrap_or(0);
    value[..end].to_owned()
}

pub(crate) fn has_pdf_header(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(PDF_PROBE_BYTES)]
        .windows(b"%PDF-".len())
        .any(|window| window == b"%PDF-")
}

fn checked_download_size(
    current_size: usize,
    chunk_size: usize,
) -> Result<usize, DownloadPdfError> {
    let next_size = current_size
        .checked_add(chunk_size)
        .ok_or_else(|| DownloadPdfError::new("too-large", "PDF 超过 100 MiB 下载上限。"))?;

    if next_size > MAX_PDF_BYTES {
        return Err(DownloadPdfError::new(
            "too-large",
            "PDF 超过 100 MiB 下载上限。",
        ));
    }

    Ok(next_size)
}

fn network_error(error: reqwest::Error) -> DownloadPdfError {
    if error.is_timeout() {
        DownloadPdfError::new("network-timeout", "下载超时，请检查网络后重试。")
    } else {
        DownloadPdfError::new("network-failed", "无法从论文网站获取 PDF，请稍后重试。")
    }
}

pub(crate) async fn request_with_safe_redirects(
    initial_url: Url,
    accept: &str,
    allowed_host: Option<fn(&Url) -> bool>,
) -> Result<(reqwest::Response, Url), DownloadPdfError> {
    let mut current_url = initial_url;

    for redirect_count in 0..=MAX_REDIRECTS {
        if allowed_host.is_some_and(|check| !check(&current_url)) {
            return Err(DownloadPdfError::new(
                "untrusted-landing-page",
                "论文页面跳转到了非可信站点，已停止元数据解析。",
            ));
        }
        // Resolve and pin every hop independently. The connection therefore
        // cannot be redirected through DNS rebinding to an unvalidated IP.
        let client = pinned_client_for(&current_url).await?;
        let response = client
            .get(current_url.clone())
            .header(USER_AGENT, "PaperLens/0.1 (+desktop academic PDF reader)")
            .header(ACCEPT, accept)
            .send()
            .await
            .map_err(network_error)?;

        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err(DownloadPdfError::new(
                    "redirect-limit",
                    "下载链接重定向次数过多，已停止下载。",
                ));
            }

            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| invalid_url("论文网站返回了无效的重定向地址。"))?;
            let next_url = current_url
                .join(location)
                .map_err(|_| invalid_url("论文网站返回了无效的重定向地址。"))?;
            validate_download_url(&next_url)?;
            current_url = next_url;
            continue;
        }

        if !response.status().is_success() {
            return Err(DownloadPdfError::with_status(response.status()));
        }

        return Ok((response, current_url));
    }

    unreachable!("redirect loop always returns on its final iteration")
}

async fn read_pdf_body(mut response: reqwest::Response) -> Result<Vec<u8>, DownloadPdfError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PDF_BYTES as u64)
    {
        return Err(DownloadPdfError::new(
            "too-large",
            "PDF 超过 100 MiB 下载上限。",
        ));
    }

    let initial_capacity = response
        .content_length()
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or(0)
        .min(MAX_PDF_BYTES);
    let mut contents = Vec::with_capacity(initial_capacity);

    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        checked_download_size(contents.len(), chunk.len())?;
        contents.extend_from_slice(&chunk);

        if contents.len() >= PDF_PROBE_BYTES && !has_pdf_header(&contents) {
            return Err(DownloadPdfError::new(
                "invalid-pdf",
                "下载内容不是有效的 PDF，可能是登录页或网站错误页。",
            ));
        }
    }

    if !has_pdf_header(&contents) {
        return Err(DownloadPdfError::new(
            "invalid-pdf",
            "下载内容不是有效的 PDF，可能是登录页或网站错误页。",
        ));
    }

    Ok(contents)
}

fn unique_storage_prefix() -> String {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = DOWNLOAD_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{milliseconds}-{sequence:08x}")
}

pub(crate) fn save_pdf(
    app_local_data: &Path,
    display_name: &str,
    contents: &[u8],
) -> Result<String, DownloadPdfError> {
    let pdf_directory = app_local_data.join(PDF_DIRECTORY);
    fs::create_dir_all(&pdf_directory).map_err(|_| {
        DownloadPdfError::new("write-failed", "无法创建 PaperLens 本地 PDF 资料库。")
    })?;

    let prefix = unique_storage_prefix();
    let storage_name = format!("{prefix}-{display_name}");
    let temporary_path = pdf_directory.join(format!(".{prefix}.part"));
    let final_path = pdf_directory.join(&storage_name);

    let write_result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)?;
        file.write_all(contents)?;
        file.sync_all()?;
        fs::rename(&temporary_path, &final_path)?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temporary_path);
        return Err(DownloadPdfError::new(
            "write-failed",
            "PDF 已下载，但无法保存到 PaperLens 本地资料库。",
        ));
    }

    Ok(format!("{PDF_DIRECTORY}/{storage_name}"))
}

async fn download_pdf_to_directory(
    app_local_data: &Path,
    url: &str,
    suggested_name: Option<&str>,
) -> Result<DownloadedPdf, DownloadPdfError> {
    let initial_url = parse_download_url(url)?;
    let (response, final_url) = request_with_safe_redirects(
        initial_url,
        "application/pdf,application/octet-stream;q=0.9",
        None,
    )
    .await?;
    let contents = read_pdf_body(response).await?;
    let display_name = safe_pdf_name(suggested_name, &final_url);
    let local_file_path = save_pdf(app_local_data, &display_name, &contents)?;

    Ok(DownloadedPdf {
        local_file_path,
        display_name,
        byte_size: contents.len() as u64,
    })
}

#[tauri::command]
pub async fn download_pdf(
    app: tauri::AppHandle,
    url: String,
    suggested_name: Option<String>,
) -> Result<DownloadedPdf, DownloadPdfError> {
    let directory = app.path().app_local_data_dir().map_err(|_| {
        DownloadPdfError::new("write-failed", "无法定位 PaperLens 本地资料库。")
    })?;
    download_pdf_to_directory(&directory, &url, suggested_name.as_deref()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    // Opt-in network smoke test: same HTTPS/DNS/redirect/header/storage pipeline
    // as the UI command, but with a caller-supplied isolated test directory.
    #[test]
    #[ignore = "requires a public PDF URL and isolated output directory"]
    fn live_pdf_download() {
        let url = std::env::var("PAPERLENS_SMOKE_PDF_URL").expect("Set PAPERLENS_SMOKE_PDF_URL");
        let output = std::env::var("PAPERLENS_SMOKE_OUTPUT_DIR").expect("Set PAPERLENS_SMOKE_OUTPUT_DIR");
        let directory = Path::new(&output).canonicalize().expect("Create the isolated output directory first");
        let download = tauri::async_runtime::block_on(download_pdf_to_directory(
            &directory, &url, Some("Attention Is All You Need.pdf"),
        )).expect("Original PDF download failed");
        let path = directory.join(&download.local_file_path);
        let contents = fs::read(&path).unwrap();
        assert!(has_pdf_header(&contents));
        assert_eq!(contents.len() as u64, download.byte_size);
        println!("PDF_SMOKE {}", serde_json::json!({ "path": path, "byteSize": download.byte_size, "url": url }));
    }

    #[test]
    fn accepts_public_https_urls() {
        let parsed = parse_download_url("https://arxiv.org/pdf/1706.03762").unwrap();
        assert_eq!(parsed.host_str(), Some("arxiv.org"));
    }

    #[test]
    fn rejects_non_https_and_embedded_credentials() {
        assert_eq!(
            parse_download_url("http://example.org/paper.pdf")
                .unwrap_err()
                .code,
            "unsafe-url"
        );
        assert_eq!(
            parse_download_url("https://reader:secret@example.org/paper.pdf")
                .unwrap_err()
                .code,
            "unsafe-url"
        );
    }

    #[test]
    fn rejects_local_domains_and_non_public_ip_literals() {
        for raw_url in [
            "https://localhost/paper.pdf",
            "https://service.local/paper.pdf",
            "https://127.0.0.1/paper.pdf",
            "https://10.2.3.4/paper.pdf",
            "https://169.254.1.2/paper.pdf",
            "https://192.168.1.20/paper.pdf",
            "https://[::1]/paper.pdf",
            "https://[fc00::1]/paper.pdf",
            "https://[fe80::1]/paper.pdf",
        ] {
            assert_eq!(parse_download_url(raw_url).unwrap_err().code, "unsafe-url");
        }
    }

    #[test]
    fn accepts_public_ip_literals() {
        assert!(parse_download_url("https://1.1.1.1/paper.pdf").is_ok());
        assert!(parse_download_url("https://[2606:4700:4700::1111]/paper.pdf").is_ok());
    }

    #[test]
    fn rejects_a_domain_resolution_if_any_address_is_private() {
        let mixed = [
            SocketAddr::from(([104, 26, 10, 78], 443)),
            SocketAddr::from(([192, 168, 1, 4], 443)),
        ];
        assert_eq!(
            validate_resolved_addresses(&mixed).unwrap_err().code,
            "unsafe-url"
        );
        assert_eq!(
            validate_resolved_addresses(&[]).unwrap_err().code,
            "network-failed"
        );
    }

    #[test]
    fn accepts_a_domain_resolution_when_all_addresses_are_public() {
        let public = [
            SocketAddr::from(([104, 26, 10, 78], 443)),
            SocketAddr::new("2606:4700:4700::1111".parse().unwrap(), 443),
        ];
        assert!(validate_resolved_addresses(&public).is_ok());
    }

    #[test]
    fn makes_safe_unicode_pdf_names() {
        let url = Url::parse("https://example.org/files/fallback.pdf").unwrap();
        assert_eq!(
            safe_pdf_name(Some(" ../注意力：原理?* .PDF"), &url),
            "注意力：原理--.pdf"
        );
        assert_eq!(safe_pdf_name(Some("..."), &url), "document.pdf");
        let long_name = safe_pdf_name(Some(&"论".repeat(100)), &url);
        assert!(long_name.len() <= MAX_DISPLAY_NAME_BYTES + ".pdf".len());
        assert!(long_name.ends_with(".pdf"));
    }

    #[test]
    fn decodes_the_final_url_file_name_when_no_name_is_suggested() {
        let url =
            Url::parse("https://example.org/files/Attention%20Is%20All%20You%20Need.pdf").unwrap();
        assert_eq!(
            safe_pdf_name(None, &url),
            "Attention Is All You Need.pdf"
        );
    }

    #[test]
    fn finds_a_pdf_signature_only_inside_the_first_kibibyte() {
        let mut valid = vec![b' '; 1024];
        valid[1019..1024].copy_from_slice(b"%PDF-");
        assert!(has_pdf_header(&valid));

        let mut too_late = vec![b' '; 1030];
        too_late[1024..1029].copy_from_slice(b"%PDF-");
        assert!(!has_pdf_header(&too_late));
    }

    #[test]
    fn enforces_the_streamed_size_limit_at_the_exact_boundary() {
        assert_eq!(
            checked_download_size(MAX_PDF_BYTES - 1, 1).unwrap(),
            MAX_PDF_BYTES
        );
        assert_eq!(
            checked_download_size(MAX_PDF_BYTES, 1).unwrap_err().code,
            "too-large"
        );
        assert_eq!(
            checked_download_size(usize::MAX, 1).unwrap_err().code,
            "too-large"
        );
    }
}
