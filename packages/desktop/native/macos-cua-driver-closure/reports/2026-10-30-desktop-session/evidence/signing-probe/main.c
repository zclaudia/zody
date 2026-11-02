#include <stdio.h>
extern int zody_probe(void);
int main(void) { printf("value=%d\n", zody_probe()); return zody_probe()==7 ? 0 : 1; }
