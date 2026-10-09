use regex::Regex;
use serde::Serialize;
use std::{fs, io::Read, path::{Path, PathBuf}, time::UNIX_EPOCH};
use tauri::Manager;
use url::Url;

use crate::remote_pdf::{
    has_pdf_header, parse_download_url, request_with_safe_redirects, safe_pdf_name, save_pdf,
    DownloadPdfError, DownloadedPdf, MAX_PDF_BYTES,
};

const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;

fn is_trusted_scholarly_host(host: &str) -> bool {
    const HOSTS: &[&str] = &[
        "aclanthology.org", "arxiv.org", "biomedcentral.com", "core.ac.uk",
        "europepmc.org", "frontiersin.org", "ieee.org", "mdpi.com", "nature.com",
        "ncbi.nlm.nih.gov", "plos.org", "proceedings.mlr.press",
        "proceedings.neurips.cc", "papers.neurips.cc", "papers.nips.cc", "sciencedirect.com", "springer.com",
        "tandfonline.com", "thecvf.com", "wiley.com",
    ];
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    HOSTS.iter().any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let pattern = format!(
        r#"(?is)\b{}\s*=\s*(?:"([^"]*)"|'([^']*)')"#,
        regex::escape(name),
    );
    let captures = Regex::new(&pattern).ok()?.captures(tag)?;
    captures.get(1).or_else(|| captures.get(2)).map(|value| value.as_str().trim().to_owned())
}

fn pdf_metadata_urls(html: &str, base_url: &Url) -> Vec<String> {
    let tag_pattern = Regex::new(r"(?is)<(?:meta|link)\b[^>]*>").expect("static tag regex");
    let mut urls = Vec::new();
    for matched in tag_pattern.find_iter(html) {
        let tag = matched.as_str();
        let key = attribute(tag, "name")
            .or_else(|| attribute(tag, "property"))
            .or_else(|| attribute(tag, "rel"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        let media_type = attribute(tag, "type").unwrap_or_default().to_ascii_lowercase();
        let is_pdf_metadata = matches!(
            key.as_str(),
            "citation_pdf_url" | "eprints.document_url" | "wkhealth_pdf_url"
        ) || (key.split_whitespace().any(|value| value == "alternate")
            && media_type == "application/pdf");
        if !is_pdf_metadata {
            continue;
        }
        let raw_url = attribute(tag, "content").or_else(|| attribute(tag, "href"));
        let Some(raw_url) = raw_url else { continue };
        let Ok(url) = base_url.join(&raw_url) else { continue };
        if parse_download_url(url.as_str()).is_ok() && !urls.iter().any(|item| item == url.as_str()) {
            urls.push(url.to_string());
        }
    }
    urls
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LandingPageResolution {
    pdf_urls: Vec<String>,
}

#[tauri::command]
pub async fn resolve_landing_page(
    url: String,
) -> Result<LandingPageResolution, DownloadPdfError> {
    let initial_url = parse_download_url(&url)?;
    let host = initial_url.host_str().unwrap_or_default();
    if !is_trusted_scholarly_host(host) {
        return Err(DownloadPdfError::new(
            "untrusted-landing-page",
            "该页面不在可信学术来源列表中，未自动解析其中的下载链接。",
        ));
    }
    let (mut response, final_url) = request_with_safe_redirects(
        initial_url,
        "text/html,application/xhtml+xml;q=0.9",
        Some(|url| is_trusted_scholarly_host(url.host_str().unwrap_or_default())),
    )
    .await?;
    if !is_trusted_scholarly_host(final_url.host_str().unwrap_or_default()) {
        return Err(DownloadPdfError::new(
            "untrusted-landing-page",
            "论文页面跳转到了非可信站点，已停止元数据解析。",
        ));
    }
    if response.content_length().is_some_and(|size| size > MAX_HTML_BYTES as u64) {
        return Err(DownloadPdfError::new("html-too-large", "论文页面过大，已停止元数据解析。"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        DownloadPdfError::new("network-failed", "无法读取论文落地页。")
    })? {
        if chunk.len() > MAX_HTML_BYTES.saturating_sub(bytes.len()) {
            return Err(DownloadPdfError::new("html-too-large", "论文页面过大，已停止元数据解析。"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let html = String::from_utf8_lossy(&bytes);
    Ok(LandingPageResolution { pdf_urls: pdf_metadata_urls(&html, &final_url) })
}

fn modified_millis(path: &PathBuf) -> Option<u128> {
    fs::metadata(path).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|value| value.as_millis())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPdfCandidate {
    file_name: String,
    byte_size: u64,
    modified_at_ms: u64,
}

fn is_simple_pdf_name(name: &str) -> bool {
    !name.is_empty()
        && name.to_ascii_lowercase().ends_with(".pdf")
        && Path::new(name).components().count() == 1
        && !name.contains(['/', '\\'])
        && name != "."
        && name != ".."
}

fn inspect_browser_pdf(path: &PathBuf) -> Option<BrowserPdfCandidate> {
    let file_name = path.file_name()?.to_str()?;
    if !is_simple_pdf_name(file_name) || path.is_symlink() { return None; }
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_PDF_BYTES as u64 { return None; }
    let mut probe = [0_u8; 1024];
    let count = fs::File::open(path).ok()?.read(&mut probe).ok()?;
    if !has_pdf_header(&probe[..count]) { return None; }
    Some(BrowserPdfCandidate {
        file_name: file_name.to_owned(),
        byte_size: metadata.len(),
        modified_at_ms: u64::try_from(modified_millis(path)?).ok()?,
    })
}

#[tauri::command]
pub fn find_recent_browser_pdf(
    app: tauri::AppHandle,
    started_at_ms: u64,
    ignored_names: Vec<String>,
) -> Result<Option<BrowserPdfCandidate>, DownloadPdfError> {
    let downloads = app.path().download_dir().map_err(|_| {
        DownloadPdfError::new("downloads-unavailable", "无法定位浏览器下载文件夹。")
    })?;
    let threshold = u128::from(started_at_ms);
    let mut candidates: Vec<(u128, PathBuf)> = fs::read_dir(downloads)
        .map_err(|_| DownloadPdfError::new("downloads-unavailable", "无法读取浏览器下载文件夹。"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter_map(|path| modified_millis(&path).map(|modified| (modified, path)))
        .filter(|(modified, path)| *modified >= threshold
            && !path.file_name().and_then(|name| name.to_str()).is_some_and(|name| ignored_names.iter().any(|item| item == name)))
        .collect();
    candidates.sort_by(|left, right| right.0.cmp(&left.0));

    for (_, path) in candidates {
        if let Some(candidate) = inspect_browser_pdf(&path) { return Ok(Some(candidate)); }
    }
    Ok(None)
}

#[tauri::command]
pub fn import_browser_pdf_candidate(
    app: tauri::AppHandle,
    file_name: String,
    modified_at_ms: u64,
    byte_size: u64,
    suggested_name: Option<String>,
) -> Result<DownloadedPdf, DownloadPdfError> {
    if !is_simple_pdf_name(&file_name) {
        return Err(DownloadPdfError::new("invalid-response", "浏览器 PDF 文件名无效。"));
    }
    let downloads = app.path().download_dir().map_err(|_| {
        DownloadPdfError::new("downloads-unavailable", "无法定位浏览器下载文件夹。")
    })?;
    let path = downloads.join(&file_name);
    let candidate = inspect_browser_pdf(&path).ok_or_else(||
        DownloadPdfError::new("invalid-pdf", "浏览器下载的 PDF 已移动或不完整。"))?;
    if candidate.modified_at_ms != modified_at_ms || candidate.byte_size != byte_size {
        return Err(DownloadPdfError::new("invalid-pdf", "浏览器下载的 PDF 已发生变化，请重新选择。"));
    }
    let contents = fs::read(&path).map_err(|_| DownloadPdfError::new("downloads-unavailable", "无法读取浏览器下载的 PDF。"))?;
    if contents.len() as u64 != byte_size || !has_pdf_header(&contents) {
        return Err(DownloadPdfError::new("invalid-pdf", "浏览器下载的 PDF 已发生变化，请重新选择。"));
    }
    let placeholder = Url::parse("https://browser-download.local/document.pdf").expect("static URL");
    let display_name = safe_pdf_name(suggested_name.as_deref().or(Some(&file_name)), &placeholder);
    let app_local_data = app.path().app_local_data_dir().map_err(|_| {
        DownloadPdfError::new("write-failed", "无法定位 PaperLens 本地资料库。")
    })?;
    let local_file_path = save_pdf(&app_local_data, &display_name, &contents)?;
    Ok(DownloadedPdf { local_file_path, display_name, byte_size })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_trusts_exact_or_subdomain_scholarly_hosts() {
        assert!(is_trusted_scholarly_host("journals.plos.org"));
        assert!(is_trusted_scholarly_host("ieeexplore.ieee.org"));
        assert!(is_trusted_scholarly_host("papers.nips.cc"));
        assert!(is_trusted_scholarly_host("papers.neurips.cc"));
        assert!(!is_trusted_scholarly_host("papers.nips.cc.attacker.example"));
        assert!(!is_trusted_scholarly_host("ieee.org.attacker.example"));
    }

    #[test]
    fn extracts_only_explicit_pdf_metadata() {
        let base = Url::parse("https://journals.plos.org/article/1").unwrap();
        let html = r#"
          <meta name="citation_pdf_url" content="/article/file.pdf">
          <meta property="og:url" content="https://evil.example/tracker">
          <link rel="alternate" type="application/pdf" href="https://cdn.plos.org/paper.pdf">
        "#;
        assert_eq!(pdf_metadata_urls(html, &base), vec![
            "https://journals.plos.org/article/file.pdf",
            "https://cdn.plos.org/paper.pdf",
        ]);
    }

    #[test]
    fn browser_pdf_name_must_be_a_single_pdf_filename() {
        assert!(is_simple_pdf_name("paper.pdf"));
        assert!(!is_simple_pdf_name("../paper.pdf"));
        assert!(!is_simple_pdf_name("folder/paper.pdf"));
        assert!(!is_simple_pdf_name("paper.part"));
    }
}
