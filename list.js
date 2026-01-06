// Prefix where UI pagination is enabled
var PAGINATION_PATH_PREFIX = 'ohm-augmented-diffs/changesets/';

// UI page size (what the user sees)
var UI_PAGE_SIZE = 2000;

// S3 hard limit per request is effectively 1000; keep it at 1000
var S3_MAX_KEYS_PER_REQUEST = 1000;

// State for UI pagination
var currentUiPage = 0; // 0-based
var acc = {
  prefix: '',
  directories: [],
  files: [],        // accumulated files
  nextMarker: null, // next S3 marker
  fullyLoaded: false
};

if (typeof AUTO_TITLE != 'undefined' && AUTO_TITLE == true) {
  document.title = location.hostname;
}

if (typeof S3_REGION != 'undefined') {
  var BUCKET_URL = location.protocol + '//' + location.hostname + '.' + S3_REGION + '.amazonaws.com';
  var BUCKET_WEBSITE_URL = location.protocol + '//' + location.hostname;
}

if (typeof S3BL_IGNORE_PATH == 'undefined' || S3BL_IGNORE_PATH != true) {
  var S3BL_IGNORE_PATH = false;
}

if (typeof BUCKET_URL == 'undefined') {
  var BUCKET_URL = location.protocol + '//' + location.hostname;
}

if (typeof BUCKET_NAME != 'undefined') {
  if (!~BUCKET_URL.indexOf(location.protocol + '//' + BUCKET_NAME)) {
    BUCKET_URL += '/' + BUCKET_NAME;
  }
}

if (typeof BUCKET_WEBSITE_URL == 'undefined') {
  var BUCKET_WEBSITE_URL = BUCKET_URL;
}

if (typeof S3B_ROOT_DIR == 'undefined') {
  var S3B_ROOT_DIR = '';
}

if (typeof S3B_SORT == 'undefined') {
  var S3B_SORT = 'DEFAULT';
}

if (typeof EXCLUDE_FILE == 'undefined') {
  var EXCLUDE_FILE = [];
} else if (typeof EXCLUDE_FILE == 'string') {
  var EXCLUDE_FILE = [EXCLUDE_FILE];
}

// Polyfill includes
if (!Array.prototype.includes) {
  Object.defineProperty(Array.prototype, 'includes', {
    value: function (searchElement, fromIndex) {
      if (this == null) { throw new TypeError('"this" is null or not defined'); }
      var o = Object(this), len = o.length >>> 0;
      if (len === 0) { return false; }
      var n = fromIndex | 0, k = Math.max(n >= 0 ? n : len - Math.abs(n), 0);
      function sameValueZero(x, y) { return x === y || (typeof x === 'number' && typeof y === 'number' && isNaN(x) && isNaN(y)); }
      while (k < len) { if (sameValueZero(o[k], searchElement)) return true; k++; }
      return false;
    }
  });
}

jQuery(function ($) {
  // Buttons (ensure you have #pagination-controls with #prev-button, #next-button, #page-indicator in tu HTML)
  $('#prev-button').on('click', function () {
    if ($(this).is(':disabled')) return;
    currentUiPage = Math.max(0, currentUiPage - 1);
    renderCurrentPage();
    updatePaginationControls();
  });

  $('#next-button').on('click', function () {
    if ($(this).is(':disabled')) return;
    currentUiPage += 1;
    ensureLoadedForPage(currentUiPage).then(function () {
      renderCurrentPage();
      updatePaginationControls();
    }).fail(showError);
  });

  // Initial load
  bootstrapLoad();
});

function bootstrapLoad() {
  var prefix = detectPrefix();
  var isPaginatedPrefix = (prefix === PAGINATION_PATH_PREFIX);

  // Reset state each time prefix changes
  acc = { prefix: prefix, directories: [], files: [], nextMarker: null, fullyLoaded: false };
  currentUiPage = 0;

  if (isPaginatedPrefix) {
    $('#pagination-controls').show();
    $('#listing').html('<img src="//assets.okfn.org/images/icons/ajaxload-circle.gif" />');
    // Fetch all pages to sort by date descending (newest first)
    fetchAllPages(prefix).then(function (fullInfo) {
      var info = applyExclusions(fullInfo);
      acc.directories = info.directories;
      acc.files = info.files;
      acc.fullyLoaded = true;
      // Sort: Newest first (by File Number)
      acc.files.sort(function (a, b) {
        var aIdMatch = a.Key.match(/(\d+)/);
        var bIdMatch = b.Key.match(/(\d+)/);
        var aId = aIdMatch ? parseInt(aIdMatch[1]) : 0;
        var bId = bIdMatch ? parseInt(bIdMatch[1]) : 0;
        return aId < bId ? 1 : -1;
      });
      renderCurrentPage();
      updatePaginationControls();
    }).fail(showError);
  } else {
    $('#pagination-controls').hide();
    // Fallback: simple listing without UI pagination (fetch all S3 pages concatenated visually)
    fetchAllPages(prefix).then(function (fullInfo) {
      var info = applyExclusions(fullInfo);
      if (S3B_SORT != 'DEFAULT') {
        info.files.sort(sortFunction);
      }
      renderTable(info.directories.concat(info.files), info.prefix, 1);
      buildNavigation({ prefix: info.prefix });
    }).fail(showError);
  }
}

function sortFunction(a, b) {
  switch (S3B_SORT) {
    case "OLD2NEW": return a.LastModified > b.LastModified ? 1 : -1;
    case "NEW2OLD": return a.LastModified < b.LastModified ? 1 : -1;
    case "A2Z": return a.Key < b.Key ? 1 : -1;
    case "Z2A": return a.Key > b.Key ? 1 : -1;
    case "BIG2SMALL": return a.Size < b.Size ? 1 : -1;
    case "SMALL2BIG": return a.Size > b.Size ? 1 : -1;
  }
}

// Ensure we have loaded at least (pageIndex+1) * UI_PAGE_SIZE files; fetch more S3 pages as needed
function ensureLoadedForPage(pageIndex) {
  var needed = (pageIndex + 1) * UI_PAGE_SIZE;
  var dfd = $.Deferred();

  // If already loaded enough or fully loaded, resolve
  if (acc.files.length >= needed || acc.fullyLoaded) {
    dfd.resolve(); return dfd.promise();
  }

  // Otherwise, fetch more S3 pages until we have enough or until S3 ends
  function loop() {
    if (acc.files.length >= needed || acc.fullyLoaded) { dfd.resolve(); return; }
    fetchOneS3Page(acc.nextMarker).then(function (info) {
      // Accumulate
      if (!acc.directories.length) acc.directories = info.directories; // keep directories once
      acc.files = acc.files.concat(info.files);
      acc.nextMarker = (info.nextMarker && info.nextMarker !== 'null') ? decodeURIComponent(info.nextMarker) : null;
      if (!acc.nextMarker) acc.fullyLoaded = true;
      loop();
    }).fail(function (e) { dfd.reject(e); });
  }

  loop();
  return dfd.promise();
}

// Fetch a single S3 page (up to 1000 due to S3)
function fetchOneS3Page(marker) {
  var s3_rest_url = buildS3Url(acc.prefix, marker, S3_MAX_KEYS_PER_REQUEST);
  $('#listing').html('<img src="//assets.okfn.org/images/icons/ajaxload-circle.gif" />');
  return $.get(s3_rest_url).then(function (data) {
    var xml = $(data);
    var info = getInfoFromS3Data(xml);
    // For the paginated prefix, always show newest first across the whole list
    info = applyExclusions(info);
    info.files.sort(function (a, b) { return a.LastModified < b.LastModified ? 1 : -1; });
    buildNavigation({ prefix: info.prefix || acc.prefix });

    // Ensure a <base> exists once
    var base = window.location.href;
    base = (base.endsWith('/')) ? base : base + '/';
    if ($('head base').length === 0) {
      $('head').append('<base href="' + base + '">');
    }
    return info;
  });
}

// Render current UI page (slice of 2000) + parent row + numbering
function renderCurrentPage() {
  var start = currentUiPage * UI_PAGE_SIZE;
  var end = Math.min(start + UI_PAGE_SIZE, acc.files.length);
  var pageFiles = acc.files.slice(start, end);

  var items = acc.directories.concat(pageFiles);
  renderTable(items, acc.prefix, start + 1);
  buildNavigation({ prefix: acc.prefix });
}

function updatePaginationControls() {
  var hasPrev = currentUiPage > 0;
  var hasMoreLoaded = acc.files.length > (currentUiPage + 1) * UI_PAGE_SIZE;
  var canLoadMore = !acc.fullyLoaded || hasMoreLoaded;

  $('#prev-button').prop('disabled', !hasPrev);

  // If we already have enough loaded for the next page, enable Next.
  // Otherwise, enable Next and it will load on demand when clicked.
  var enableNext = canLoadMore;
  $('#next-button').prop('disabled', !enableNext);

  // Page indicator (1-based)
  var totalPages = Math.ceil(acc.files.length / UI_PAGE_SIZE);
  $('#page-number').text('Page ' + (currentUiPage + 1) + ' of ' + totalPages);
}

// Fallback: fetch all pages (used for non-paginated prefixes)
function fetchAllPages(prefix) {
  var accLocal = { files: [], directories: [], prefix: prefix, nextMarker: '' };
  function loop() {
    var url = buildS3Url(prefix, accLocal.nextMarker, S3_MAX_KEYS_PER_REQUEST);
    return $.get(url).then(function (data) {
      var xml = $(data);
      var info = getInfoFromS3Data(xml);
      info = applyExclusions(info);
      accLocal.files = accLocal.files.concat(info.files);
      accLocal.directories = accLocal.directories.concat(info.directories);
      if (info.nextMarker && info.nextMarker !== 'null') {
        accLocal.nextMarker = decodeURIComponent(info.nextMarker);
        return loop();
      } else {
        return accLocal;
      }
    });
  }
  return loop();
}

function applyExclusions(info) {
  var files = info.files, directories = info.directories;
  if (typeof DO_NOT_DISPLAY !== 'undefined' && DO_NOT_DISPLAY) {
    directories = directories.filter(function (dir) { return !DO_NOT_DISPLAY.directories.includes(dir.Key); });
    files = files.filter(function (fil) { return !DO_NOT_DISPLAY.files.includes(fil.Key); });
  }
  files = files.filter(function (f) { return !EXCLUDE_FILE.includes(f.Key); });
  return { files: files, directories: directories, prefix: info.prefix, nextMarker: info.nextMarker };
}

function buildS3Url(prefix, marker, maxKeys) {
  var s3_rest_url = BUCKET_URL + '?delimiter=/&max-keys=' + (maxKeys || S3_MAX_KEYS_PER_REQUEST);
  if (prefix) {
    var prefix_param = prefix.replace(/\/$/, '') + '/';
    s3_rest_url += '&prefix=' + prefix_param;
  }
  if (marker) {
    s3_rest_url += '&marker=' + encodeURIComponent(marker);
  }
  return s3_rest_url;
}

function detectPrefix() {
  var rx = '.*[?&]prefix=' + S3B_ROOT_DIR + '([^&]+)(&.*)?$';
  var prefix = '';
  if (S3BL_IGNORE_PATH == false) {
    prefix = location.pathname.replace(/^\//, S3B_ROOT_DIR);
  }
  var match = location.search.match(rx);
  if (match) {
    prefix = S3B_ROOT_DIR + match[1];
  } else if (S3BL_IGNORE_PATH) {
    prefix = S3B_ROOT_DIR;
  }
  return prefix || '';
}

function buildNavigation(info) {
  var root = '<a href="?prefix=">' + (BUCKET_WEBSITE_URL || BUCKET_URL) + '</a> / ';
  if (info.prefix) {
    var processedPathSegments = '';
    var content = $.map(info.prefix.split('/'), function (pathSegment) {
      if (pathSegment) {
        processedPathSegments += encodeURIComponent(pathSegment) + '/';
        return '<a href="?prefix=' + processedPathSegments + '">' + pathSegment + '</a>';
      }
    });
    $('#navigation').html(root + content.join(' / '));
  } else {
    $('#navigation').html(root);
  }
}

function getInfoFromS3Data(xml) {
  var files = $.map(xml.find('Contents'), function (item) {
    item = $(item);
    return {
      Key: item.find('Key').text(),
      LastModified: item.find('LastModified').text(),
      Size: bytesToHumanReadable(item.find('Size').text()),
      Type: 'file'
    };
  });
  var directories = $.map(xml.find('CommonPrefixes'), function (item) {
    item = $(item);
    return { Key: item.find('Prefix').text(), LastModified: '', Size: '0', Type: 'directory' };
  });

  var nextMarker = $(xml.find('IsTruncated')[0]).text() == 'true'
    ? $(xml.find('NextMarker')[0]).text()
    : null;

  return {
    files: files,
    directories: directories,
    prefix: $(xml.find('Prefix')[0]).text(),
    nextMarker: nextMarker ? encodeURIComponent(nextMarker) : 'null'
  };
}

// Rendering helpers (with numbering)
function renderTable(items, prefix, startNumber) {
  var cols = [45, 30, 15];
  var header = padRight('#', 8) + padRight('Last Modified', cols[1]) + '  ' + padRight('Size', cols[2]) + 'Key \n';
  var content = header + new Array(header.length).join('-') + '\n';

  // Parent directory row (unnumbered)
  if (prefix && prefix !== S3B_ROOT_DIR) {
    var up = prefix.replace(/\/$/, '').split('/').slice(0, -1).concat('').join('/'),
      upItem = { Key: up, LastModified: '', Size: '', keyText: '../', href: S3BL_IGNORE_PATH ? '?prefix=' + up : '../' };
    content += renderRow(upItem, cols, null) + '\n';
  }

  items.forEach(function (item, idx) {
    var keyText = item.Key.substring(prefix.length);
    if (!keyText) return;

    var href = item.Type === 'directory'
      ? (S3BL_IGNORE_PATH
        ? location.protocol + '//' + location.hostname + location.pathname + '?prefix=' + encodePath(item.Key)
        : encodePath(keyText))
      : (BUCKET_WEBSITE_URL || BUCKET_URL) + '/' + encodePath(item.Key);

    var rowObj = { LastModified: item.LastModified, Size: item.Size, keyText: keyText, href: href };
    var number = startNumber + idx;
    if (!EXCLUDE_FILE.includes(item.Key)) {
      content += renderRow(rowObj, cols, number) + '\n';
    }
  });

  document.getElementById('listing').innerHTML = '<pre>' + content + '</pre>';
}

function encodePath(path) {
  return encodeURIComponent(path).replace(/%2F/g, '/');
}

function renderRow(item, cols, number) {
  var row = '';
  var numberStr = (number === null || typeof number === 'undefined') ? '' : number.toString();
  row += padRight(numberStr, 8);
  row += padRight(item.LastModified || '', cols[1]) + '  ';
  row += padRight(item.Size || '', cols[2]);
  row += '<a href="' + item.href + '">' + item.keyText + '</a>';
  return row;
}

function padRight(padString, length) {
  var s = (padString || '').toString().slice(0, length - 3);
  if ((padString || '').toString().length > s.length) { s += '...'; }
  while (s.length < length) { s = s + ' '; }
  return s;
}

function bytesToHumanReadable(sizeInBytes) {
  if (sizeInBytes == 0) return '0';
  var i = -1;
  var units = [' kB', ' MB', ' GB', ' TB'];
  do { sizeInBytes = sizeInBytes / 1024; i++; } while (sizeInBytes > 1024);
  return Math.max(sizeInBytes, 0.1).toFixed(1) + units[i];
}

function showError(error) {
  console.error(error);
  $('#listing').html('<strong>Error: ' + error + '</strong>');
}