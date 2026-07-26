#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <unistd.h>
#include <util.h>

static volatile sig_atomic_t child_pid = -1;

static void terminate_child(int signal_number) {
  if (child_pid > 0) kill((pid_t)child_pid, SIGTERM);
  _exit(128 + signal_number);
}

static void answer_cursor_queries(int master, char *rolling) {
  char *query = NULL;
  while ((query = strstr(rolling, "\033[6n")) != NULL) {
    *query = '?';
    (void)write(master, "\033[1;1R", 6);
  }
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fputs("usage: devin-auth-pty /absolute/path/to/devin selection-index\n", stderr);
    return 64;
  }
  int selection = atoi(argv[2]);
  if (selection < 0 || selection > 2 || argv[1][0] != '/') {
    fputs("invalid login selection or Devin CLI path\n", stderr);
    return 64;
  }

  signal(SIGTERM, terminate_child);
  signal(SIGINT, terminate_child);
  int master = -1;
  struct winsize size = {.ws_row = 24, .ws_col = 100, .ws_xpixel = 0, .ws_ypixel = 0};
  pid_t child = forkpty(&master, NULL, NULL, &size);
  if (child < 0) {
    perror("forkpty");
    return 70;
  }
  if (child == 0) {
    execl(argv[1], "devin", "auth", "login", NULL);
    _exit(127);
  }
  child_pid = child;

  char rolling[32768] = {0};
  size_t used = 0;
  int selected = 0;
  int cursor_queries = 0;
  for (;;) {
    fd_set set;
    FD_ZERO(&set);
    FD_SET(master, &set);
    struct timeval timeout = {.tv_sec = 1, .tv_usec = 0};
    int ready = select(master + 1, &set, NULL, NULL, &timeout);
    if (ready > 0) {
      char chunk[4096];
      ssize_t count = read(master, chunk, sizeof(chunk));
      if (count <= 0 && errno != EINTR) {
        int status = 0;
        if (waitpid(child, &status, 0) == child) {
          child_pid = -1;
          if (WIFEXITED(status)) {
            printf("event=exit status=%d\n", WEXITSTATUS(status));
            return WEXITSTATUS(status);
          }
          printf("event=exit signal=%d\n", WTERMSIG(status));
          return 128 + WTERMSIG(status);
        }
        break;
      }
      if (count > 0) {
        if (used + (size_t)count >= sizeof(rolling)) {
          size_t keep = sizeof(rolling) / 2;
          memmove(rolling, rolling + used - keep, keep);
          used = keep;
        }
        memcpy(rolling + used, chunk, (size_t)count);
        used += (size_t)count;
        rolling[used] = 0;
        int before = cursor_queries;
        char *scan = rolling;
        while ((scan = strstr(scan, "\033[6n")) != NULL) {
          cursor_queries++;
          scan += 4;
        }
        answer_cursor_queries(master, rolling);
        if (!selected && cursor_queries > 0 && count > 100) {
          selected = 1;
          for (int index = 0; index < selection; index++) {
            (void)write(master, "\033[B", 3);
          }
          (void)write(master, "\r", 1);
          fputs("event=browser-login-started\n", stdout);
          fflush(stdout);
        } else if (before != cursor_queries) {
          fflush(stdout);
        }
      }
    } else if (ready < 0 && errno != EINTR) {
      break;
    }

    int status = 0;
    pid_t completed = waitpid(child, &status, WNOHANG);
    if (completed == child) {
      child_pid = -1;
      if (WIFEXITED(status)) {
        printf("event=exit status=%d\n", WEXITSTATUS(status));
        return WEXITSTATUS(status);
      }
      printf("event=exit signal=%d\n", WTERMSIG(status));
      return 128 + WTERMSIG(status);
    }
  }

  kill(child, SIGTERM);
  waitpid(child, NULL, 0);
  child_pid = -1;
  fputs("event=pty-closed\n", stderr);
  return 70;
}
