# parallel

The `appstack/parallel` Node.js Module.

## About

NOTICE: None of this is true quite yet, as the infrastructure hasn't been written yet. It is simply a set of notes to keep me on track.

This module defines the basis for AppStack, as it defines key components, such as the idea of a process ancestry tree and sophisticated inter-process communication. In short, a fundamental appstack program is executed on the introduction point in your program (index.js, main.js, src/main.js, etc.), and it sets up environment variables, manages secret keys, statistic querying, as well as restart procedures for your application.

From here, your application will spawn a number of worker processes, called "segments," and will curate their behavior and execution, all via this module. After this, your segment processes can start up servers according to Node.js's native `cluster` module rules. Once the application is running, there is an enormous number of things that can happen, outside of normal application behavior. You can start up a remote shell that talks to the `appstack` root ancestor executable, and query data from it, tell it to manipulate the environments of the main application process and its segments, restart the application, manage the application's internal network connections, etc. In the future, we may even have a web browser based dashboard that allows you to see the performance, logs, and statistics of your application remotely.

