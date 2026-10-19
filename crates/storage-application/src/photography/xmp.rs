use super::*;
use quick_xml::{
    events::{BytesStart, Event},
    name::ResolveResult,
    reader::NsReader,
    Writer,
};

const XMP: &str = "http://ns.adobe.com/xap/1.0/";
const DM: &str = "http://ns.adobe.com/xmp/1.0/DynamicMedia/";
const RDF: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const EMPTY_XMP: &str = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF></x:xmpmeta>"#;
fn owned(ns: &ResolveResult<'_>, local: &str) -> bool {
    match ns {
        ResolveResult::Bound(ns) if ns.as_ref() == XMP => local == "Rating",
        ResolveResult::Bound(ns) if ns.as_ref() == DM => matches!(local, "pick" | "good"),
        _ => false,
    }
}
fn rdf(ns: &ResolveResult<'_>, local: &str) -> bool {
    matches!(ns, ResolveResult::Bound(ns) if ns.as_ref() == RDF) && local == "RDF"
}

/// Seed a new independent review from existing exchange metadata. This does
/// not mark it reviewed or infer a reject flag from a negative star rating.
pub(super) fn read_mark(bytes: &[u8]) -> StorageResult<PhotoMark> {
    let mut reader = NsReader::from_reader(bytes);
    let mut scope: Vec<(bool, bool, Option<String>)> = vec![];
    let mut values = BTreeMap::<String, String>::new();
    let mut rdf_count = 0;
    loop {
        let event = reader
            .read_event()
            .map_err(|_| conflict("XMP 评分无法读取，原文件已保留"))?;
        let empty = matches!(event, Event::Empty(_));
        match event {
            Event::Start(start) | Event::Empty(start) => {
                let (ns, local) = reader.resolver().resolve_element(start.name());
                let is_rdf = rdf(&ns, local.as_ref());
                if is_rdf {
                    rdf_count += 1;
                }
                let property = if scope.last().is_some_and(|(_, photo, _)| *photo)
                    && owned(&ns, local.as_ref())
                {
                    Some(local.as_ref().to_string())
                } else {
                    None
                };
                let mut photo = scope.last().is_some_and(|(rdf, _, _)| *rdf)
                    && matches!(&ns,ResolveResult::Bound(ns) if ns.as_ref()==RDF)
                    && local.as_ref() == "Description";
                let attributes = start
                    .attributes()
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| conflict("XMP 属性无效"))?;
                for attribute in &attributes {
                    let (ns, local) = reader.resolver().resolve_attribute(attribute.key);
                    if matches!(ns,ResolveResult::Bound(ns) if ns.as_ref()==RDF)
                        && local.as_ref() == "about"
                        && !attribute.value.is_empty()
                    {
                        photo = false;
                    }
                }
                if photo {
                    for attribute in attributes {
                        let (ns, local) = reader.resolver().resolve_attribute(attribute.key);
                        if owned(&ns, local.as_ref()) {
                            values.insert(
                                local.as_ref().into(),
                                quick_xml::escape::unescape(attribute.value.as_ref())
                                    .map_err(|_| conflict("XMP 评分格式无效"))?
                                    .into_owned(),
                            );
                        }
                    }
                }
                if !empty {
                    scope.push((is_rdf, photo, property));
                }
            }
            Event::Text(text) => {
                if let Some((_, _, Some(property))) = scope.last() {
                    values
                        .entry(property.clone())
                        .or_default()
                        .push_str(text.as_ref());
                }
            }
            Event::End(_) => {
                scope.pop();
            }
            Event::DocType(_) => return Err(conflict("XMP 文档类型不受支持，原文件已保留")),
            Event::Eof => break,
            _ => {}
        }
    }
    if !scope.is_empty() || rdf_count != 1 {
        return Err(conflict("XMP 内容不完整，原文件已保留"));
    }
    let rating = values
        .get("Rating")
        .and_then(|v| v.trim().parse::<u8>().ok())
        .filter(|v| *v <= 5)
        .unwrap_or(0);
    let flag = match values.get("pick").and_then(|v| v.trim().parse::<i8>().ok()) {
        Some(1) => PhotoFlag::Pick,
        Some(-1) => PhotoFlag::Reject,
        Some(0) => PhotoFlag::None,
        _ => match values
            .get("good")
            .map(|v| v.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("true") => PhotoFlag::Pick,
            Some("false") => PhotoFlag::Reject,
            _ => PhotoFlag::None,
        },
    };
    Ok(PhotoMark {
        rating,
        flag,
        reviewed: false,
    })
}

/// Rewrite only the three exchange properties. Namespace aliases and element/attribute
/// forms are supported; all unknown fields, adjustments, comments and packets survive.
fn merge(bytes: Option<&[u8]>, rating: u8, flag: PhotoFlag) -> StorageResult<Vec<u8>> {
    let bytes = bytes.unwrap_or(EMPTY_XMP.as_bytes());
    let mut reader = NsReader::from_reader(bytes);
    let mut writer = Writer::new(Vec::new());
    let mut skipping = 0usize;
    let mut inserted = 0;
    // (RDF container, primary photo description). Nested resources and other
    // RDF subjects can have their own Rating properties; leave those intact.
    let mut scope: Vec<(bool, bool)> = Vec::new();
    let pick = match flag {
        PhotoFlag::Pick => 1,
        PhotoFlag::Reject => -1,
        PhotoFlag::None => 0,
    };
    let good = match flag {
        PhotoFlag::Pick => "<xmpDM:good>True</xmpDM:good>",
        PhotoFlag::Reject => "<xmpDM:good>False</xmpDM:good>",
        PhotoFlag::None => "",
    };
    let properties = format!(
        r#"<rdf:Description xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpDM="http://ns.adobe.com/xmp/1.0/DynamicMedia/" rdf:about=""><xmp:Rating>{rating}</xmp:Rating><xmpDM:pick>{pick}</xmpDM:pick>{good}</rdf:Description>"#
    );
    loop {
        let event = reader
            .read_event()
            .map_err(|_| conflict("已有 XMP 格式无效，原文件已保留"))?;
        if skipping > 0 {
            match event {
                Event::Start(_) => skipping += 1,
                Event::End(_) => skipping -= 1,
                Event::Eof => return Err(conflict("XMP 内容不完整，未覆盖")),
                _ => {}
            }
            continue;
        }
        match event {
            Event::Start(ref start) | Event::Empty(ref start) => {
                let (ns, local) = reader.resolver().resolve_element(start.name());
                if scope.last().is_some_and(|(_, photo)| *photo) && owned(&ns, local.as_ref()) {
                    if matches!(event, Event::Start(_)) {
                        skipping = 1;
                    }
                    continue;
                }
                let is_rdf = rdf(&ns, local.as_ref());
                let mut photo_description = scope.last().is_some_and(|(rdf, _)| *rdf)
                    && matches!(&ns,ResolveResult::Bound(ns) if ns.as_ref()==RDF)
                    && local.as_ref() == "Description";
                for attribute in start.attributes() {
                    let attribute = attribute.map_err(|_| conflict("XMP 属性无效"))?;
                    let (ns, local) = reader.resolver().resolve_attribute(attribute.key);
                    if matches!(ns,ResolveResult::Bound(ns) if ns.as_ref()==RDF)
                        && local.as_ref() == "about"
                        && !attribute.value.is_empty()
                    {
                        photo_description = false;
                    }
                }
                let name = start.name().as_ref().to_owned();
                let mut clean = BytesStart::new(name);
                for attribute in start.attributes() {
                    let attribute = attribute.map_err(|_| conflict("XMP 属性无效"))?;
                    let (ns, local) = reader.resolver().resolve_attribute(attribute.key);
                    if !photo_description || !owned(&ns, local.as_ref()) {
                        clean.push_attribute(attribute);
                    }
                }
                if matches!(event, Event::Empty(_)) && is_rdf {
                    writer
                        .write_event(Event::Start(clean.clone()))
                        .map_err(|_| invalid("无法生成 XMP"))?;
                    writer.get_mut().extend_from_slice(properties.as_bytes());
                    inserted += 1;
                    writer
                        .write_event(Event::End(clean.to_end()))
                        .map_err(|_| invalid("无法生成 XMP"))?;
                    continue;
                }
                if matches!(event, Event::Start(_)) {
                    scope.push((is_rdf, photo_description));
                }
                writer
                    .write_event(if matches!(event, Event::Start(_)) {
                        Event::Start(clean)
                    } else {
                        Event::Empty(clean)
                    })
                    .map_err(|_| invalid("无法生成 XMP"))?;
            }
            Event::End(ref end) => {
                scope.pop();
                let (ns, local) = reader.resolver().resolve_element(end.name());
                if rdf(&ns, local.as_ref()) {
                    writer.get_mut().extend_from_slice(properties.as_bytes());
                    inserted += 1;
                }
                writer
                    .write_event(event)
                    .map_err(|_| invalid("无法生成 XMP"))?;
            }
            Event::DocType(_) => return Err(conflict("XMP 包含不支持的文档类型，未覆盖")),
            Event::Eof => break,
            _ => writer
                .write_event(event)
                .map_err(|_| invalid("无法生成 XMP"))?,
        }
    }
    if inserted != 1 {
        return Err(conflict("XMP 缺少唯一的 RDF 元数据，未覆盖"));
    }
    Ok(writer.into_inner())
}

impl StorageService {
    pub async fn photo_prepare_lrc(&self, session_id: Uuid) -> StorageResult<PhotoHandoff> {
        let _sync = self.photo_sync_lock.lock().await;
        let _guard = self.photo_lock.lock().await;
        let _mutation = self.mutation_lock.read().await;
        let (mut revision, mut catalog) = self.load_photos().await?;
        let index = session_index(&catalog, session_id)?;
        let ids = catalog.sessions[index].photo_ids.clone();
        let archive = archive_for(&catalog, catalog.sessions[index].archive_id)?.clone();
        let backend = self.backend(archive.raw.volume_id).await?;
        let mut result = PhotoHandoff {
            directories: vec![],
            failures: vec![],
            jpg_only: 0,
        };
        let mut directories = std::collections::BTreeSet::new();
        for pi in 0..catalog.photos.len() {
            if !ids.contains(&catalog.photos[pi].id) || catalog.photos[pi].excluded {
                continue;
            }
            let photo = catalog.photos[pi].clone();
            let Some(raw) = photo.files.iter().find(|f| f.kind == PhotoFileKind::Raw) else {
                result.jpg_only += 1;
                continue;
            };
            let raw_target = file_target(&archive, raw)?;
            let outcome = async {
                if !self.photo_review_workspace
                    && (!raw.verified || photo.files.iter().any(|f| !f.verified))
                {
                    return Err(conflict("照片尚未完整归档，请先重试导入"));
                }
                if backend.stat(&raw_target).await?.kind != StorageEntryKind::File {
                    return Err(conflict("RAW 原片已不存在"));
                }
                let sidecar = format!("{}.xmp", raw.path.rsplit_once('.').unwrap().0);
                let target = child(&archive.raw, &sidecar)?;
                let before =
                    sync::read_document(backend.as_ref(), &target, 4 * 1024 * 1024).await?;
                let actual = before.as_ref().map(|(_, bytes)| bytes_hash(bytes));
                if self.photo_review_workspace && photo.revision == 0 {
                    if let Some((_, bytes)) = &before {
                        read_mark(bytes)?;
                    }
                }
                if actual != photo.xmp_hash {
                    let proposed = merge(
                        before.as_ref().map(|(_, bytes)| bytes.as_slice()),
                        photo.rating,
                        photo.flag,
                    )?;
                    let copy = child(
                        &archive.raw,
                        &format!(
                            "{}.filo-conflict-{}.xmp",
                            raw.path.rsplit_once('.').unwrap().0,
                            Uuid::new_v4()
                        ),
                    )?;
                    sync::write_document(backend.as_ref(), &copy, None, &proposed).await?;
                    return Err(conflict(
                        "XMP 被其他应用更新，原文件及 Filo 合并候选均已保留，请先核对",
                    ));
                }
                // Explicit handoff only. No background XMP writer competes with Lightroom.
                if (photo.xmp_synced_revision != Some(photo.revision) || before.is_none())
                    && !(self.photo_review_workspace && photo.revision == 0 && before.is_some())
                {
                    let bytes = merge(
                        before.as_ref().map(|(_, bytes)| bytes.as_slice()),
                        photo.rating,
                        photo.flag,
                    )?;
                    sync::write_document(
                        backend.as_ref(),
                        &target,
                        before.as_ref().map(|(entry, _)| entry),
                        &bytes,
                    )
                    .await?;
                    catalog.photos[pi].xmp_hash = Some(bytes_hash(&bytes));
                    catalog.photos[pi].xmp_synced_revision = Some(photo.revision);
                    touch(&mut catalog, photo.id);
                    self.save_photos(revision, &catalog).await?;
                    revision += 1;
                }
                let parent = raw_target
                    .logical_path
                    .rsplit_once('/')
                    .map(|(p, _)| p)
                    .unwrap_or("");
                let directory = StorageLocator {
                    logical_path: parent.to_string(),
                    ..raw_target.clone()
                };
                let (_, physical) = backend
                    .storage_path(&directory)
                    .ok_or_else(|| invalid("LRC 需要系统可访问的 RAW 目录"))?;
                directories.insert(physical);
                Ok(())
            }
            .await;
            if let Err(error) = outcome {
                result
                    .failures
                    .push(format!("{}：{}", raw.path, error.message));
            }
        }
        result.directories = directories.into_iter().collect();
        catalog.sessions[index].handed_off =
            result.failures.is_empty() && !result.directories.is_empty();
        catalog.sessions[index].revision += 1;
        self.save_photos(revision, &catalog).await?;
        Ok(result)
    }

    pub async fn photo_open_raw_directory(
        &self,
        session_id: Uuid,
        directory: String,
    ) -> StorageResult<()> {
        let catalog = self.photo_catalog().await?;
        let session = &catalog.sessions[session_index(&catalog, session_id)?];
        let archive = archive_for(&catalog, session.archive_id)?;
        let backend = self.backend(archive.raw.volume_id).await?;
        for file in catalog
            .photos
            .iter()
            .filter(|p| session.photo_ids.contains(&p.id))
            .flat_map(|p| &p.files)
            .filter(|f| f.kind == PhotoFileKind::Raw)
        {
            let target = file_target(archive, file)?;
            let path = StorageLocator {
                logical_path: target
                    .logical_path
                    .rsplit_once('/')
                    .map(|(p, _)| p)
                    .unwrap_or("")
                    .to_string(),
                ..target
            };
            if backend
                .storage_path(&path)
                .is_some_and(|(_, physical)| physical == directory)
            {
                return backend.open(&path).await;
            }
        }
        Err(invalid("目录不属于此批次"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_adjustments_and_aliases_and_keeps_flags_independent_of_rating() {
        let original = br#"<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><r:Description xmlns:q="http://ns.adobe.com/xap/1.0/" xmlns:d="http://ns.adobe.com/xmp/1.0/DynamicMedia/" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" q:Rating="2" d:good="True" crs:Exposure2012="+0.50"><d:pick>1</d:pick><crs:ToneCurve><r:Seq><r:li>0, 0</r:li></r:Seq></crs:ToneCurve></r:Description><r:Description r:about="urn:other" xmlns:q="http://ns.adobe.com/xap/1.0/" q:Rating="5"/></r:RDF></x:xmpmeta><?xpacket end="w"?>"#;
        let rejected = merge(Some(original), 3, PhotoFlag::Reject).unwrap();
        let text = String::from_utf8(rejected.clone()).unwrap();
        assert!(text.contains("crs:Exposure2012=\"+0.50\""));
        assert!(text.contains("<r:li>0, 0</r:li>"));
        assert!(!text.contains("q:Rating=\"2\""));
        assert!(text.contains("q:Rating=\"5\""));
        assert!(!text.contains("<d:pick>"));
        assert!(text.contains("<xmp:Rating>3</xmp:Rating>"));
        assert!(text.contains("<xmpDM:pick>-1</xmpDM:pick>"));
        let cleared =
            String::from_utf8(merge(Some(&rejected), 3, PhotoFlag::None).unwrap()).unwrap();
        assert!(!cleared.contains("xmpDM:good"));
        assert!(cleared.contains("<xmp:Rating>3</xmp:Rating>"));
        assert_eq!(cleared.matches("<xmp:Rating>").count(), 1);
        assert!(merge(Some(b"<bad>"), 0, PhotoFlag::None).is_err());
    }
}
