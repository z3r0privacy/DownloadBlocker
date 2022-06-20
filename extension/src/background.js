async function initConfig(){

  let managedConfig = await chrome.storage.managed.get();

  if (managedConfig.Config){
    console.log("Found managed config");
    try{
      return new configuration(JSON.parse(managedConfig.Config));
    }catch{
      console.log("Got JSON error when trying to parse configuration")
      return null;
    }
  }else{
    console.log("Didn't find managed config, using default.")
    return await configuration.loadDefaultConfig();
  }
}

// [GUID] => DownloadId
// GUID_[GUID] -> {macros, sha256 etc.}
// DownloadID_ID -> [GUID]

async function getStorageDataByKey(key){
  let data = await chrome.storage.session.get(key);
  return data?.[key] ?? null;
}

async function writeStorageData(key, value){
  var data = {};
  data[key] = value;
  return await chrome.storage.session.set(data);
}

async function getDownloadFromGuid(guid){

  let downloadId = await getStorageDataByKey(guid);

  if(!downloadId){
    return null;
  }

  let matchingDownloads = await chrome.downloads.search({id: downloadId});

  return matchingDownloads?.[0];
  
}

async function correlateDownloadWithMetaData(downloadItem){
  
  let downloadGuid = await getStorageDataByKey("DownloadID_" + downloadItem.id);

  if(downloadGuid){
    return await getStorageDataByKey("GUID_" + downloadGuid)
  }
  
  for(const [storageKey, storageData] of Object.entries(await chrome.storage.session.get())){

    /* 
      e.g. 
      "GUID_fbf5b3bd-2bb5-1f49-99ad-af49d8773b47" ->
        {
          guid: 'fbf5b3bd-2bb5-1f49-99ad-af49d8773b47',
          id: 'blob:https://www.outflank.nl/d740384d-8b10-4740-b489-9d97d0ba3017',
          initiatingPage: 'https://www.outflank.nl/demo/html_smuggling.html',
          sha256: 'Pending'
        }
    */
   
    if(downloadItem.finalUrl == storageData.id){
      await writeStorageData(storageData.guid, downloadItem.id);
      await writeStorageData("DownloadID_" + downloadItem.id, storageData.guid);
      return storageData;
    }
  }

  return null;
}

// Load initial config

// Listen for async event giving us a file's metadata, including SHA256 hash, referer and file inspection data.
chrome.runtime.onMessage.addListener(
  async function(request, sender, sendResponse) {
    // console.log(sender.tab ? "from a content script:" + sender.tab.url : "from the extension");
    sendResponse(true);
    if(!request){
      console.log("Request was null?");
      return;
    }

    let guid = request.guid;

    let existingData = await getStorageDataByKey("GUID_" + guid);
    if(existingData){
      request.sha256 = request.sha256 && request.sha256 != "Pending" ? request.sha256 : existingData.sha256;
      request.referringPage = existingData.referringPage ?? request.initiatingPage;
      request.id = existingData.id ?? request.id;
      // This assumes that all file inspection data is sent together. Maybe we should merge arrays instead?
      request.fileInspectionData == existingData.fileInspectionData ?? request.fileInspectionData;      
    }

    await writeStorageData("GUID_" + guid, request);

    let downloadItem = await getDownloadFromGuid(guid);

    if(downloadItem){
      await processDownload(downloadItem);
    }
  }
);

// Cancel a download
function cancelDownloadInProgress(downloadItem){
  chrome.downloads.cancel(downloadItem.id, function(){
    if(chrome.runtime.lastError){
      console.log(chrome.runtime.lastError.message);
    }

    chrome.downloads.erase({"id" : downloadItem.id}, function(){ 
      if(chrome.runtime.lastError){
        console.log(chrome.runtime.lastError.message);
      }
    });
  });
}

// Delete a download that has already finished
function deleteSuccessfulDownload(downloadItem){
  chrome.downloads.removeFile(downloadItem.id, function(){
    if(chrome.runtime.lastError){
      console.log(chrome.runtime.lastError.message);
    }

    chrome.downloads.erase({"id" : downloadItem.id}, function(){
      if(chrome.runtime.lastError){
        console.log(chrome.runtime.lastError.message);
      }
    });
  });
}

function abortDownload(downloadItem){    

  if(downloadItem.state == "interrupted"){
    console.log("state was interrupted");
    return;
  }

  if(downloadItem.state == "complete"){
    deleteSuccessfulDownload(downloadItem);    
  }else{
    cancelDownloadInProgress(downloadItem);
  }
}

/*
  This function can be called multiple times per download (e.g.)
    When the download is first created
    When the download's filename has been determined
    Whenever the download changes state (in_progress, interrupted, complete)
    When the file's SHA256 hash has been calculated
    When fille inspection has been completed
*/
async function processDownload(downloadItem){

  if(downloadItem.state !== "complete"){
    return;
  }

  var filename = downloadItem.filename;

  let config = await initConfig();
  if(!filename){
    console.log("filename was null");
    return;
  }

  if(!config){
    console.log("Config wasn't loaded in time.");
    return;
  }

  let downloadData = await correlateDownloadWithMetaData(downloadItem);

  if(downloadData?.sha256 == "Pending" || (downloadData && downloadData?.fileInspectionData == null)){
    console.log(`[${downloadItem.filename}] Waiting for metadata, state is ` + downloadItem.state);
    return;
  }

  if(downloadData){
    // Copy file metadata to updated DownloadItem for audit / notification
    downloadItem.sha256 = downloadData.sha256;
    downloadItem.fileInspectionData = downloadData.fileInspectionData;
  }

  // getCurrentUrl() uses the currently active tab, which might not actually be the tab that initiated the download. Where possible, give priority to the URL provided by the content script.
  downloadItem.referringPage = downloadData?.referringPage || await getCurrentUrl();

  console.log("Processing download with id: " + downloadItem.id + ", state is: " + downloadItem.state);
  console.log(structuredClone(downloadItem));

  var matchedRule = config.getMatchedRule(downloadItem);

  if(!matchedRule){
    console.log("Download didn't match any rules")
    return;
  }

  console.log("Matched rule:");
  console.log(matchedRule);

  // Default to block except where action is set explicitly to something else

  var ruleAction = config.getRuleAction(matchedRule);
  
  downloadItem["action"] = ruleAction; // For alerting purposes

  var shouldBlockDownload = !["audit", "notify"].includes(ruleAction);

  if(shouldBlockDownload || (ruleAction == "audit" && !config.getAlertConfig())){
    if(shouldBlockDownload){
      console.log("Action not set to audit or notify, blocking download");
    }else{
      console.log("Action not set to audit or notify, but no alertConfig is specified, blocking download");
    }

    abortDownload(downloadItem);

  }else{
    if(ruleAction == "notify"){
      console.log("Rule action is set to notify, download won't be blocked.");
    }else{
      console.log("Rule action is set to audit, download won't be blocked.");
    }
  }

  if(ruleAction != "audit"){
    // If the ruleAction is not audit, i.e. it's block or notify, we need to send the user a notification
    var titleTemplateName = ruleAction == "block" ? "download_blocked_message_title" : "download_notify_message_title";
    var bodyTemplateName  = ruleAction == "block" ? "download_blocked_message_body"  : "download_notify_message_body";

    var title = Utils.parseString(matchedRule.titleTemplate, downloadItem) || await chrome.i18n.getMessage(titleTemplateName);
    var message = Utils.parseString(matchedRule.messageTemplate, downloadItem) || await chrome.i18n.getMessage(bodyTemplateName, [downloadItem.filename, downloadItem.referringPage, downloadItem.finalUrl]);
    Utils.notifyUser(title, message);
  }

  await config.sendAlertMessage(downloadItem);
}

chrome.downloads.onCreated.addListener(function (downloadItem){
    if(chrome.runtime.lastError){
      console.log(chrome.runtime.lastError.message);
    }
    console.log("Download created");
    correlateDownloadWithMetaData(downloadItem);
  }
);

chrome.downloads.onChanged.addListener(function callback(downloadDelta){

  if(chrome.runtime.lastError){
    console.log(chrome.runtime.lastError.message);
  }
  if(downloadDelta.state){

    chrome.downloads.search({'id' : downloadDelta.id}, function(items){
      if(chrome.runtime.lastError){
        console.log(chrome.runtime.lastError.message);
      }

      if(items && items.length == 1){
        processDownload(items[0]);
      }
    });
  }
});

try{
  const scriptId = "DownloadBlockerScript_" + Utils.generateGuid();

  console.log(`Injecting script with ID '${scriptId}'`);
  
  chrome.scripting.registerContentScripts([{
    allFrames : true,
    id: scriptId,
    js : ["src/inject.js"],
    matches : ["<all_urls>"],
    runAt : "document_start",
    world: "MAIN"
  }]);

  if(chrome.runtime.lastError){
    console.log(chrome.runtime.lastError);
  }

}catch(e){
  console.log(e);
}

async function getCurrentUrl() {
  let queryOptions = {active: true, currentWindow: true};
  let [tab] = await chrome.tabs.query(queryOptions);
  return tab?.url;
}