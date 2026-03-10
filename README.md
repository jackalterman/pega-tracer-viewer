# Pega Tracer Viewer

A single-file browser tool for exploring Pega tracer XML files. No server, no install, no data leaves your machine.

## Quick Start

1. Open `index.html` in Chrome, Edge, or Firefox
2. Drop a Pega tracer XML file onto the drop zone, or click **Open File**
3. Wait for parsing to complete (progress bar shown for large files)
4. Explore the tabs

## Features

### Summary Tab
Overview of the entire trace at a glance — total events, failures, warnings, exceptions, thread count, date range, and slowest operation. Includes a health banner, clickable lists of failed/exception/warning events, top 15 slowest operations, and an event type breakdown chart.

### Tree Tab
Hierarchical call tree built from Begin/End event pairs. Expand and collapse nodes, filter to errors only, or let the global search drive what's visible. Color-coded by event type (Activity, Flow, DB, Decision, DataTransform, Connect, Exception, Validate).

### Table Tab
Virtual-scrolling flat table of all events with column sorting and filters for status and event type. Only renders visible rows so it stays fast on 500k+ event traces.

### Flamegraph Tab
Canvas-based sequence/depth visualization. Scroll to zoom, drag to pan, click a frame to open its detail panel. Frame width represents the sequence range the event spans.

### Search Tab
Full-text and regex search across all event fields including raw XML. Results appear as you type with match highlighting. Activates automatically when you start typing; filters the Tree and Table tabs to matching events only.

- **Ctrl+F** focuses the search bar from anywhere
- **Escape** clears the search and returns all views to normal
- The `.*` button toggles regex mode

### Event Detail Panel
Click any event row, tree node, or search result to open a slide-in panel showing all fields and the raw XML. Close with the ✕ button or click elsewhere.

## Global Search

The search bar in the header searches every field: `eventType`, `keyname`, `name`, `stepStatus`, `stepMethod`, `stepPage`, `step`, `message`, `threadName`, `interaction`, `workPool`, `inskey`, `rsname`, `dateTime`, and raw XML content. When a search is active, the Tree and Table tabs are filtered to matching events and show a purple banner with a clear button.

## Debug Export

The **⬇ debug** button (enabled after a file is loaded) exports a plain-text schema snapshot intended to help an AI improve the parser or viewer. It contains:

- Event type counts with percentages
- Schema fingerprint — which attributes and child elements appear per event type, CDATA presence, anomalies, and the 5 largest events by byte size
- One structural sample per event type with all attribute values and text content removed (shape only)

No individual event data, no user data fields. The output is small enough to paste directly into a chat window.

## Performance

- Streams the file in 3 MB chunks — handles 200–500 MB+ XML files without freezing the browser
- Yields to the UI thread between chunks so the progress bar stays responsive
- Table and Search results use virtual scrolling — only visible rows are rendered
- Search runs in async 3,000-event chunks to avoid blocking on large traces

## File Format

Expects standard Pega Tracer XML with `<TraceEvent>` elements. Recognized attributes: `sequence`, `ruleNumber`, `stepMethod`, `stepPage`, `step`, `stepStatus`, `eventType`, `elapsed`, `name`, `inskey`, `keyname`, `rsname`, `rsvers`. Recognized child elements: `DateTime`, `ThreadName`, `Interaction`, `WorkPool`, `Message`.
