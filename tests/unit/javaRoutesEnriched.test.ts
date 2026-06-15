import { describe, expect, it } from 'vitest';
import { parseSpringRoutes } from '@background/parser/languages/java';
import type { RepoFile } from '@shared/types';

const makeFile = (path: string, content: string): RepoFile => ({ path, content });

// ---------------------------------------------------------------------------
// Spring — regression: class prefix + method mappings still work
// ---------------------------------------------------------------------------

describe('parseSpringRoutes (regression)', () => {
  it('should keep detecting class @RequestMapping prefix with @GetMapping when no handler params present', () => {
    const file = makeFile(
      'src/UserController.java',
      `
@RestController
@RequestMapping(value = "/api/v1")
public class UserController {
    @GetMapping("/users")
    public List<User> getUsers() { return users; }
}
`
    );
    const routes = parseSpringRoutes([file]);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/api/v1/users', source: 'spring' });
  });

  it('should not treat method-level @RequestMapping(method=...) as a class prefix', () => {
    const file = makeFile(
      'src/PingController.java',
      `
@RestController
public class PingController {
    @RequestMapping(value = "/ping", method = RequestMethod.GET)
    public String ping() { return "pong"; }
}
`
    );
    const routes = parseSpringRoutes([file]);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/ping' });
  });
});

// ---------------------------------------------------------------------------
// Spring — enriched: query params, path variable typing, request body
// ---------------------------------------------------------------------------

describe('parseSpringRoutes (enriched)', () => {
  it('should recover @RequestParam params into queryParams with required flags', () => {
    const file = makeFile(
      'src/SearchController.java',
      `
@RestController
@RequestMapping("/api")
public class SearchController {
    @GetMapping("/search")
    public List<Item> search(
        @RequestParam String q,
        @RequestParam(value = "page", required = false) int page,
        @RequestParam(defaultValue = "10") int size
    ) { return items; }
}
`
    );
    const routes = parseSpringRoutes([file]);
    expect(routes).toHaveLength(1);
    const query = routes[0]?.queryParams ?? [];
    expect(query).toEqual(
      expect.arrayContaining([
        { name: 'q', required: true, type: 'string' },
        { name: 'page', required: false, type: 'integer' },
        { name: 'size', required: false, type: 'integer' }
      ])
    );
  });

  it('should type @PathVariable params from the Java type', () => {
    const file = makeFile(
      'src/OrderController.java',
      `
@RestController
public class OrderController {
    @GetMapping("/orders/{orderId}/items/{itemKey}")
    public Item getItem(@PathVariable long orderId, @PathVariable String itemKey) { return item; }
}
`
    );
    const routes = parseSpringRoutes([file]);
    expect(routes[0]?.path).toBe('/orders/:orderId/items/:itemKey');
    const pathParams = routes[0]?.pathParams ?? [];
    expect(pathParams).toEqual(
      expect.arrayContaining([
        { name: 'orderId', required: true, type: 'integer' },
        { name: 'itemKey', required: true, type: 'string' }
      ])
    );
  });

  it('should extract @RequestBody DTO fields from an in-file DTO class', () => {
    const file = makeFile(
      'src/UserController.java',
      `
@RestController
public class UserController {
    @PostMapping("/users")
    public User create(@RequestBody CreateUserDto dto) { return user; }
}

class CreateUserDto {
    private String name;
    private int age;
    private boolean active;
}
`
    );
    const routes = parseSpringRoutes([file]);
    expect(routes).toHaveLength(1);
    const body = routes[0]?.body;
    expect(body?.type).toBe('object');
    expect(body?.properties?.name).toMatchObject({ type: 'string' });
    expect(body?.properties?.age).toMatchObject({ type: 'integer' });
    expect(body?.properties?.active).toMatchObject({ type: 'boolean' });
  });

  it('should set body to a plain object schema when the DTO is not in-file', () => {
    const file = makeFile(
      'src/UserController.java',
      `
@RestController
public class UserController {
    @PostMapping("/users")
    public User create(@RequestBody ExternalDto dto) { return user; }
}
`
    );
    const routes = parseSpringRoutes([file]);
    expect(routes[0]?.body).toEqual({ type: 'object' });
  });
});

// ---------------------------------------------------------------------------
// JAX-RS
// ---------------------------------------------------------------------------

describe('parseSpringRoutes (JAX-RS)', () => {
  it('should detect class @Path prefix with method @GET and @Path', () => {
    const file = makeFile(
      'src/ItemResource.java',
      `
@Path("/api")
public class ItemResource {
    @GET
    @Path("/items")
    public List<Item> list() { return items; }

    @POST
    @Path("/items")
    public Item create(Item item) { return item; }
}
`
    );
    const routes = parseSpringRoutes([file]);
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/api/items', source: 'jaxrs' });
    expect(routes[1]).toMatchObject({ method: 'POST', path: '/api/items', source: 'jaxrs' });
  });

  it('should map a method with no method-level @Path to the class prefix', () => {
    const file = makeFile(
      'src/RootResource.java',
      `
@Path("/status")
public class RootResource {
    @GET
    public String status() { return "ok"; }
}
`
    );
    const routes = parseSpringRoutes([file]);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/status', source: 'jaxrs' });
  });

  it('should recover @QueryParam and typed @PathParam in JAX-RS', () => {
    const file = makeFile(
      'src/ItemResource.java',
      `
@Path("/api")
public class ItemResource {
    @GET
    @Path("/items/{id}")
    public Item find(@PathParam("id") long id, @QueryParam("q") String q) { return item; }
}
`
    );
    const routes = parseSpringRoutes([file]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.path).toBe('/api/items/:id');
    expect(routes[0]?.pathParams).toEqual(expect.arrayContaining([{ name: 'id', required: true, type: 'integer' }]));
    expect(routes[0]?.queryParams).toEqual(expect.arrayContaining([{ name: 'q', required: false, type: 'string' }]));
  });
});
