---
description: Scaffold a runnable Spring Boot Maven project — the files that must exist before it counts as done, and the two traps that have already produced a Hello-World skeleton instead.
---

# Scaffolding a Spring Boot project

## The trap that has already fired

`mvn archetype:generate -DarchetypeArtifactId=maven-archetype-quickstart` produces a
**plain Java** project, not a Spring Boot one. Used for a Spring Boot request, it
delivered:

- JUnit **3.8.1** — a dependency line that has not been current since 2011
- `App.java` printing `Hello World!`, `AppTest.java` asserting `true`
- no `spring-boot-starter-parent`, no `@SpringBootApplication`, no Spring at all

So: for Spring Boot, do **not** reach for an archetype. Write the files.

## The files, and what each one is for

A Spring Boot project is not finished until every line below exists. Write them with
the `write` tool — it creates parent directories, so the package structure appears as
a side effect of writing the files, with no `mkdir` step to get wrong.

    pom.xml                                          without this nothing builds
    src/main/resources/application.yml               port, datasource, encoding
    src/main/java/<group>/<app>/Application.java     @SpringBootApplication + main()
    src/main/java/<group>/<app>/<layer>/...          controller / service / repository
    src/test/java/<group>/<app>/ApplicationTests.java   at least a context-loads test

`pom.xml` must declare `spring-boot-starter-parent` as its `<parent>`, and at minimum
`spring-boot-starter-web`. Pin the Java release in `<properties>`, and do not invent a
version for a starter — the parent manages those.

Each file's declared `package` must match the directory it lands in. A Java file that
says `package com.example.cafe.controller` but sits in the project root compiles
nowhere, and every tool will still report the write as successful.

**The application class must sit in the PARENT package of everything else.** Spring
scans outward from the package the application class is declared in, and nowhere else —
so `com.example.cafe.Application` finds `com.example.cafe.controller.MenuController`,
while `com.example.cafeapp.Application` finds **nothing at all**. This failure is nastier
than a compile error: it compiles, it starts, and then every route returns 404, which
reads as "the API is broken" rather than "the class is in the wrong place". A generated
project has already done exactly this — main class in `com.coffeeshopordering`, every
other class in `com.coffeeshop`.

## Run Maven in batch mode, always

    mvn -B clean package
    mvn -B spring-boot:run

Without `-B` (or `-DinteractiveMode=false`), any plugin that wants confirmation prints
a prompt and waits. **The shell has no terminal attached, so nothing can ever answer
it.** The command sits there until the two-minute timeout kills it, and the only thing
reported is that it was killed — which reads as "the tool is broken" rather than "it is
waiting for a keystroke". This has already cost a full turn.

## The shell here is cmd.exe, not bash

The `bash` tool is named `bash` but runs through `cmd.exe` on this machine. Do not send
it `#` comments, `mkdir -p` (`cmd` has no `-p`), heredocs, or single-quoted multi-line
arguments. Do not write file contents through it at all: `echo '<project>…' > pom.xml`
is the idiom that fails hardest — it either errors or writes the shell's mangled
version of the text. Use the `write` tool. One command per line.

## Create the directory once

`mkdir x` followed by a tool that also creates `x` gives you `x/x`, and the project
ends up nested one level deeper than anyone expects. Create the project directory in
one place and write into it; do not repeat the `mkdir`.

## Before reporting done

Run `mvn -B clean package` and quote the line that says `BUILD SUCCESS`. A skeleton
without a build file is not a scaffold — it is a directory of text files. If the build
cannot be run, say which file is missing rather than describing the project as
complete.
